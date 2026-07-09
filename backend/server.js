require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false } : false
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Auto-create tags tables if they don't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(60) NOT NULL UNIQUE,
    color VARCHAR(20) NOT NULL DEFAULT '#5b6af0',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS contact_tags (
    contact_email TEXT REFERENCES contacts(email) ON DELETE CASCADE,
    tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (contact_email, tag_id)
  );
`).catch(e => console.error('tags table creation error:', e.message));

// Key/value store for shared app settings (e.g. category colors). Values are JSONB
// so they persist server-side and are identical for every user of the CRM.
pool.query(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
`).catch(e => console.error('app_settings table creation error:', e.message));

// When a category is set manually in the CRM, lock the row so automatic sources
// (Smartlead webhooks, CSV imports) never overwrite the human decision.
pool.query(`ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS category_locked BOOLEAN DEFAULT FALSE;`)
  .catch(e => console.error('campaign_leads.category_locked migration error:', e.message));

// Add cleaned-value columns (originals intact) and an auto-computed
// personalization_status. Statements run in order (single query).
pool.query(`
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_name_cleaned VARCHAR(255);
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_cleaned    VARCHAR(255);
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS personalization_status TEXT
    GENERATED ALWAYS AS (
      CASE WHEN first_name_cleaned IS NOT NULL AND first_name_cleaned <> ''
                AND company_cleaned IS NOT NULL AND company_cleaned <> ''
           THEN 'Ready' ELSE 'Generic' END
    ) STORED;
`).catch(e => console.error('contacts columns migration error:', e.message));

// One-time consolidation: fold the legacy listkit_id column into source
// (source wins where both exist), then drop listkit_id. Idempotent: once the
// column is gone the block is a no-op.
pool.query(`
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'contacts' AND column_name = 'listkit_id') THEN
      UPDATE contacts
         SET source = listkit_id
       WHERE (source IS NULL OR source = '')
         AND listkit_id IS NOT NULL AND listkit_id <> '';
      ALTER TABLE contacts DROP COLUMN listkit_id;
    END IF;
  END $$;
`).catch(e => console.error('listkit_id→source consolidation error:', e.message));

// Drop the retired ELV columns (elv_esp, elv_result) and the leftover
// "ELV Internal Result" custom field. All idempotent (no-op once gone).
pool.query(`ALTER TABLE contacts DROP COLUMN IF EXISTS elv_esp;`)
  .catch(e => console.error('elv_esp drop error:', e.message));
pool.query(`ALTER TABLE contacts DROP COLUMN IF EXISTS elv_result;`)
  .catch(e => console.error('elv_result drop error:', e.message));
pool.query(`UPDATE contacts SET custom_fields = custom_fields - 'ELV Internal Result'
            WHERE custom_fields ? 'ELV Internal Result';`)
  .catch(e => console.error('ELV Internal Result custom-field drop error:', e.message));

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ═══════════════════════════════════════════════════════════
// WEBHOOK SMARTLEAD
// ═══════════════════════════════════════════════════════════
// Timing-safe compare that never throws on length mismatch.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Shared-secret gate for the webhook. When SMARTLEAD_SECRET is set, the request
// must carry the same secret — via ?token=/?secret= query param or the
// x-webhook-secret header (put the token in the webhook URL you register in
// Smartlead). When the env var is unset, the webhook stays open (back-compat).
function webhookAuthorized(req) {
  const expected = process.env.SMARTLEAD_SECRET;
  if (!expected) return true;
  const provided = req.query.token || req.query.secret || req.headers['x-webhook-secret'];
  return safeEqual(provided, expected);
}

// Pull the first email address out of a free-form string like "Name <a@b.com>".
function extractEmail(s) {
  if (!s) return null;
  const m = String(s).match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// Synthetic campaign that collects untracked replies (ones Smartlead couldn't
// attribute to a real campaign), so they still land in a contact's history.
const UNTRACKED_CAMPAIGN = 'Sin campaña';

app.post('/webhook/smartlead', async (req, res) => {
  if (!webhookAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const payload = req.body;
  const eventType = payload.event_type;

  try {
    // Untracked replies have a different shape: no lead_email/campaign, and the
    // sender's address lives inside sender_detail ("Name <email>"). Park them under
    // the synthetic "Sin campaña" so they show up in the contact's history as a
    // reply to be read and re-categorized manually.
    if (eventType === 'UNTRACKED_REPLIES') {
      const leadEmail = extractEmail(payload.sender_detail);
      if (!leadEmail) return res.json({ ok: true, msg: 'no sender email' });
      const rm = payload.reply_message || {};
      const msg = stripHtml(rm.html || '') || rm.text || payload.visible_text || '';
      const repliedAt = rm.time || payload.event_timestamp || null;
      await pool.query(
        `INSERT INTO contacts (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [leadEmail]);
      await pool.query(`
        INSERT INTO campaign_leads (email, campaign_name, lead_category, reply_message, replied_at)
        VALUES ($1, $2, 'Replied', $3, $4)
        ON CONFLICT (email, campaign_name) DO UPDATE SET
          reply_message = EXCLUDED.reply_message,
          replied_at    = EXCLUDED.replied_at,
          lead_category = CASE WHEN campaign_leads.category_locked
                                 OR campaign_leads.lead_category IN ('Interested','Comprado')
                          THEN campaign_leads.lead_category ELSE 'Replied' END,
          updated_at    = NOW()
      `, [leadEmail, UNTRACKED_CAMPAIGN, msg, repliedAt]);
      return res.json({ ok: true, event: eventType, email: leadEmail });
    }

    const email = payload.lead_email || payload.to_email;
    if (!email) return res.json({ ok: true, msg: 'no email' });

    const ignored = ['CAMPAIGN_STATUS_CHANGED', 'MANUAL_STEP_REACHED', 'EMAIL_LINK_CLICK'];
    if (ignored.includes(eventType)) return res.json({ ok: true, msg: 'ignored' });

    const lead = payload.lead_data || {};
    await pool.query(`
      INSERT INTO contacts (email, first_name, last_name, company, phone, linkedin_personal)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (email) DO UPDATE SET
        first_name      = COALESCE(EXCLUDED.first_name, contacts.first_name),
        last_name       = COALESCE(EXCLUDED.last_name, contacts.last_name),
        company         = COALESCE(EXCLUDED.company, contacts.company),
        phone           = COALESCE(EXCLUDED.phone, contacts.phone),
        linkedin_personal = COALESCE(EXCLUDED.linkedin_personal, contacts.linkedin_personal),
        updated_at      = NOW()
    `, [
      email,
      payload.lead_name || lead.first_name || payload.to_name || null,
      lead.last_name || null,
      lead.company_name || null,
      lead.phone_number || null,
      lead.linkedin_profile || null,
    ]);

    switch (eventType) {
      case 'LEAD_CATEGORY_UPDATED': {
        const category = payload.category || payload.lead_category?.new_name || null;
        const sentiment = lead.category?.sentiment_type || null;
        const lastReply = payload.last_reply || payload.lastReply || {};
        const msg = stripHtml(lastReply.email_body || '');
        const repliedAt = lastReply.time || payload.event_timestamp || null;
        await pool.query(`
          INSERT INTO campaign_leads
            (email, campaign_id, campaign_name, lead_category, sentiment, reply_message, history, replied_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (email, campaign_name) DO UPDATE SET
            lead_category = CASE WHEN campaign_leads.category_locked
                            THEN campaign_leads.lead_category ELSE EXCLUDED.lead_category END,
            sentiment     = EXCLUDED.sentiment,
            reply_message = EXCLUDED.reply_message,
            history       = EXCLUDED.history,
            replied_at    = EXCLUDED.replied_at,
            updated_at    = NOW()
        `, [email, payload.campaign_id || null, payload.campaign_name || null,
            category, sentiment, msg, JSON.stringify(payload.history || []), repliedAt]);
        break;
      }
      case 'EMAIL_REPLY': {
        const replyMsg = payload.reply_message || {};
        const msg = stripHtml(replyMsg.html || payload.reply_body || '');
        const repliedAt = payload.time_replied || payload.event_timestamp || null;
        await pool.query(`
          INSERT INTO campaign_leads (email, campaign_id, campaign_name, lead_category, reply_message, replied_at)
          VALUES ($1,$2,$3,'Replied',$4,$5)
          ON CONFLICT (email, campaign_name) DO UPDATE SET
            reply_message = CASE WHEN campaign_leads.lead_category = 'Interested'
                            THEN campaign_leads.reply_message ELSE EXCLUDED.reply_message END,
            replied_at    = EXCLUDED.replied_at,
            updated_at    = NOW()
        `, [email, payload.campaign_id || null, payload.campaign_name || null, msg, repliedAt]);
        break;
      }
      case 'EMAIL_BOUNCE':
        await pool.query(`UPDATE contacts SET email_bounced = TRUE, updated_at = NOW() WHERE email = $1`, [email]);
        break;
      case 'LEAD_UNSUBSCRIBED':
        await pool.query(`UPDATE contacts SET no_contact = TRUE, updated_at = NOW() WHERE email = $1`, [email]);
        break;
      case 'EMAIL_SENT':
        await pool.query(`
          INSERT INTO campaign_leads (email, campaign_id, campaign_name, lead_category)
          VALUES ($1,$2,$3,'Sent')
          ON CONFLICT (email, campaign_name) DO NOTHING
        `, [email, payload.campaign_id || null, payload.campaign_name || null]);
        break;
      case 'EMAIL_OPEN':
        await pool.query(`
          INSERT INTO campaign_leads (email, campaign_id, campaign_name, lead_category)
          VALUES ($1,$2,$3,'Opened')
          ON CONFLICT (email, campaign_name) DO UPDATE SET
            lead_category = CASE WHEN campaign_leads.category_locked
                                   OR campaign_leads.lead_category IN ('Interested','Replied','Comprado')
                            THEN campaign_leads.lead_category ELSE 'Opened' END,
            updated_at = NOW()
        `, [email, payload.campaign_id || null, payload.campaign_name || null]);
        break;
    }

    res.json({ ok: true, event: eventType, email });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── TEMPORARY debug capture ──────────────────────────────────────────────────
// Captures raw webhook payloads in memory ONLY (no DB writes) so undocumented
// events can be inspected. Point a webhook at POST /webhook/debug?token=... then
// read them back from GET /webhook/debug?token=... . Safe to remove afterwards.
const debugPayloads = [];
app.post('/webhook/debug', (req, res) => {
  if (!webhookAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  debugPayloads.unshift({ received_at: new Date().toISOString(), event_type: req.body?.event_type || null, body: req.body });
  if (debugPayloads.length > 20) debugPayloads.length = 20;
  res.json({ ok: true, captured: debugPayloads.length });
});
app.get('/webhook/debug', (req, res) => {
  if (!webhookAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  res.json({ count: debugPayloads.length, payloads: debugPayloads });
});

// ═══════════════════════════════════════════════════════════
// CONTACTS
// ═══════════════════════════════════════════════════════════
const SORTABLE_COLS = {
  'email': 'c.email', 'first_name': 'c.first_name', 'last_name': 'c.last_name',
  'first_name_cleaned': 'c.first_name_cleaned',
  'company': 'c.company', 'company_cleaned': 'c.company_cleaned',
  'industry': 'c.industry', 'city': 'c.city', 'state': 'c.state',
  'job_title': 'c.job_title', 'phone': 'c.phone', 'department': 'c.department',
  'country': 'c.country', 'source': 'c.source',
  'company_url': 'c.company_url', 'linkedin_personal': 'c.linkedin_personal',
  'linkedin_company': 'c.linkedin_company', 'lead_category': 'c.lead_category',
  'last_activity': 'last_activity', 'created_at': 'c.created_at',
  'total_campaigns': 'total_campaigns',
  'personalization_status': 'c.personalization_status',
  'category': 'categories',
  'flags': '(c.no_contact::int + c.email_bounced::int)',
  'tags': '(SELECT COUNT(*) FROM contact_tags ct2 WHERE ct2.contact_email = c.email)',
};

const FILTERABLE_COLS = new Set(['email','company','company_cleaned','first_name','last_name','first_name_cleaned','personalization_status','industry','city','state','country','source','job_title','department','phone','company_url','linkedin_personal','linkedin_company','lead_category']);

// Builds a parameterized WHERE clause shared by /api/contacts and /api/contacts/column-values.
// Pass excludeField to skip any active filter on that field (used so the Excel-style value
// picker for a column shows values consistent with all OTHER active filters, "cascading").
// op: 'contains' | 'exact' | 'empty' | 'not_empty' | 'in'
function buildContactWhere(query, { excludeField } = {}) {
  const { search, campaign, category, no_contact, bounced, filters } = query;
  const params = [];
  const conditions = [];
  let p = 1;

  if (search) {
    conditions.push(`(c.email ILIKE $${p} OR c.first_name ILIKE $${p} OR c.last_name ILIKE $${p} OR c.company ILIKE $${p})`);
    params.push(`%${search}%`); p++;
  }
  // Multi-campaign filter (comma-separated)
  if (campaign) {
    const campsArr = campaign.split('|||').map(s => s.trim()).filter(Boolean);
    const wantNoCampaign = campsArr.includes('__no_campaign__');
    const realCamps = campsArr.filter(c => c !== '__no_campaign__');
    const orParts = [];
    if (realCamps.length === 1) {
      orParts.push(`EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.email = c.email AND cl.campaign_name ILIKE $${p})`);
      params.push(`%${realCamps[0]}%`); p++;
    } else if (realCamps.length > 1) {
      orParts.push(`EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.email = c.email AND cl.campaign_name = ANY($${p}))`);
      params.push(realCamps); p++;
    }
    if (wantNoCampaign) {
      orParts.push(`NOT EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.email = c.email)`);
    }
    if (orParts.length) conditions.push('(' + orParts.join(' OR ') + ')');
  }
  // Multi-category filter (comma-separated)
  if (category) {
    const catsArr = category.split('|||').map(s => s.trim()).filter(Boolean);
    if (catsArr.length === 1) {
      conditions.push(`EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.email = c.email AND cl.lead_category = $${p})`);
      params.push(catsArr[0]); p++;
    } else if (catsArr.length > 1) {
      conditions.push(`EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.email = c.email AND cl.lead_category = ANY($${p}))`);
      params.push(catsArr); p++;
    }
  }
  if (no_contact === 'true') conditions.push(`c.no_contact = TRUE`);
  if (bounced === 'true') conditions.push(`c.email_bounced = TRUE`);

  // Dynamic field filters: [{field, value, op}]
  if (filters) {
    try {
      const fArr = JSON.parse(filters);
      for (const f of fArr) {
        if (excludeField && f.field === excludeField) continue;
        const isNull  = f.op === 'empty';
        const notNull = f.op === 'not_empty';
        const isIn    = f.op === 'in' && Array.isArray(f.value);

        if (FILTERABLE_COLS.has(f.field)) {
          if (isNull) {
            conditions.push(`(c.${f.field} IS NULL OR c.${f.field} = '')`);
          } else if (notNull) {
            conditions.push(`(c.${f.field} IS NOT NULL AND c.${f.field} != '')`);
          } else if (isIn) {
            if (f.value.length) {
              conditions.push(`c.${f.field} = ANY($${p})`);
              params.push(f.value); p++;
            }
          } else if (f.value) {
            if (f.op === 'exact') {
              conditions.push(`LOWER(c.${f.field}) = LOWER($${p})`);
              params.push(f.value); p++;
            } else {
              conditions.push(`c.${f.field} ILIKE $${p}`);
              params.push(`%${f.value}%`); p++;
            }
          }
        }

        // Custom field filter: field starts with 'cf:'
        if (f.field && f.field.startsWith('cf:')) {
          const cfKey = f.field.slice(3).replace(/'/g, "''");
          if (isNull) {
            conditions.push(`(c.custom_fields->>'${cfKey}' IS NULL OR c.custom_fields->>'${cfKey}' = '')`);
          } else if (notNull) {
            conditions.push(`(c.custom_fields->>'${cfKey}' IS NOT NULL AND c.custom_fields->>'${cfKey}' != '')`);
          } else if (isIn) {
            if (f.value.length) {
              conditions.push(`c.custom_fields->>'${cfKey}' = ANY($${p})`);
              params.push(f.value); p++;
            }
          } else if (f.value) {
            if (f.op === 'exact') {
              conditions.push(`LOWER(c.custom_fields->>'${cfKey}') = LOWER($${p})`);
              params.push(f.value); p++;
            } else {
              conditions.push(`c.custom_fields->>'${cfKey}' ILIKE $${p}`);
              params.push(`%${f.value}%`); p++;
            }
          }
        }

        if (f.field === 'tag') {
          if (isNull) {
            conditions.push(`NOT EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_email = c.email)`);
          } else if (notNull) {
            conditions.push(`EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_email = c.email)`);
          } else if (isIn) {
            if (f.value.length) {
              conditions.push(`EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_email = c.email AND t.name = ANY($${p}))`);
              params.push(f.value); p++;
            }
          } else if (f.value) {
            if (f.op === 'exact') {
              conditions.push(`EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_email = c.email AND LOWER(t.name) = LOWER($${p}))`);
              params.push(f.value); p++;
            } else {
              conditions.push(`EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_email = c.email AND t.name ILIKE $${p})`);
              params.push(`%${f.value}%`); p++;
            }
          }
        }
      }
    } catch (_) {}
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

app.get('/api/contacts', auth, async (req, res) => {
  try {
    const { page = 1, limit = 50, sort_by = 'email', sort_dir = 'ASC' } = req.query;
    const offset = (page - 1) * limit;
    const { where, params } = buildContactWhere(req.query);

    // Lightweight mode: return only the matching emails across ALL pages (no limit),
    // used by "select all matching" in the UI.
    if (req.query.emails_only === '1') {
      const r = await pool.query(`SELECT c.email FROM contacts c ${where} ORDER BY c.email`, params);
      return res.json({ emails: r.rows.map(x => x.email) });
    }

    let orderCol;
    if (sort_by && sort_by.startsWith('cf:')) {
      const cfKey = sort_by.slice(3).replace(/'/g, "''");
      orderCol = `c.custom_fields->>'${cfKey}'`;
    } else {
      orderCol = SORTABLE_COLS[sort_by] || 'c.email';
    }
    const orderDir = sort_dir === 'DESC' ? 'DESC' : 'ASC';

    const total = parseInt((await pool.query(`SELECT COUNT(*) FROM contacts c ${where}`, params)).rows[0].count);

    const rows = await pool.query(`
      SELECT
        c.*,
        (SELECT COUNT(*) FROM campaign_leads cl WHERE cl.email = c.email) AS total_campaigns,
        (SELECT STRING_AGG(DISTINCT cl.lead_category, ', ')
         FROM campaign_leads cl WHERE cl.email = c.email) AS categories,
        (SELECT STRING_AGG(DISTINCT cl.campaign_name, ' | ')
         FROM campaign_leads cl WHERE cl.email = c.email) AS campaigns,
        (SELECT MAX(cl.replied_at)
         FROM campaign_leads cl WHERE cl.email = c.email) AS last_activity,
        (SELECT JSON_AGG(JSON_BUILD_OBJECT('id', t.id, 'name', t.name, 'color', t.color))
         FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
         WHERE ct.contact_email = c.email) AS tags
      FROM contacts c ${where}
      ORDER BY ${orderCol} ${orderDir} NULLS LAST
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    res.json({ total, page: parseInt(page), limit: parseInt(limit), data: rows.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contacts/custom-field-keys', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT jsonb_object_keys(custom_fields) AS key
      FROM contacts
      WHERE custom_fields IS NOT NULL AND custom_fields != '{}'::jsonb
      ORDER BY key
    `);
    res.json(result.rows.map(r => r.key));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Shared category colors (category name/keyword → hex). Stored server-side so every
// user sees the same colors in the Category column. GET returns overrides only ({}
// when none set); the frontend merges these over its built-in defaults.
app.get('/api/settings/cat-colors', auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'cat_colors'`);
    res.json(r.rows[0]?.value || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings/cat-colors', auth, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    // Keep only string→string entries so we never store unexpected shapes.
    const colors = {};
    for (const [k, v] of Object.entries(body)) {
      if (typeof k === 'string' && typeof v === 'string') colors[k] = v;
    }
    await pool.query(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('cat_colors', $1::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [JSON.stringify(colors)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Distinct campaign categories (lead_category) present in the data, most common first.
// Feeds the Category filter dropdown so it always reflects real values (incl. Comprado).
app.get('/api/categories', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT lead_category AS value, COUNT(*)::int AS count
      FROM campaign_leads
      WHERE lead_category IS NOT NULL AND lead_category <> ''
      GROUP BY lead_category
      ORDER BY count DESC, value ASC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Excel-style filter picker: distinct values (+counts) for a column, respecting all
// OTHER currently active filters (search/campaign/category/filters minus this field).
app.get('/api/contacts/column-values', auth, async (req, res) => {
  try {
    const { field } = req.query;
    if (!field) return res.status(400).json({ error: 'field required' });

    let col;
    if (field.startsWith('cf:')) {
      const cfKey = field.slice(3).replace(/'/g, "''");
      col = `c.custom_fields->>'${cfKey}'`;
    } else if (FILTERABLE_COLS.has(field)) {
      col = `c.${field}`;
    } else {
      return res.status(400).json({ error: 'field not filterable' });
    }

    const { where, params } = buildContactWhere(req.query, { excludeField: field });
    const nullCheck = `${col} IS NOT NULL AND ${col} != ''`;
    let fullWhere = where ? `${where} AND ${nullCheck}` : `WHERE ${nullCheck}`;

    // value_search filters the distinct values themselves (not the contacts).
    if (req.query.value_search) {
      params.push(`%${req.query.value_search}%`);
      fullWhere += ` AND ${col} ILIKE $${params.length}`;
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 1000);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const dir = String(req.query.sort_dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const orderBy = req.query.sort_by === 'value' ? `value ${dir}` : `count ${dir}, value ASC`;

    const totalResult = await pool.query(
      `SELECT COUNT(DISTINCT ${col})::int AS total FROM contacts c ${fullWhere}`, params);
    const result = await pool.query(`
      SELECT ${col} AS value, COUNT(*)::int AS count
      FROM contacts c
      ${fullWhere}
      GROUP BY ${col}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${(page - 1) * limit}
    `, params);
    res.json({ rows: result.rows, total: totalResult.rows[0].total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cleanup tab: rename/merge a set of existing values for a column into one canonical
// value across ALL matching contacts (not scoped to the Contacts page filters).
// newValue === '' clears the field (sets NULL / removes the custom field key).
app.post('/api/contacts/merge-values', auth, async (req, res) => {
  try {
    const { field, values, newValue } = req.body;
    if (!field || !Array.isArray(values) || !values.length) {
      return res.status(400).json({ error: 'field and values[] required' });
    }
    const clear = !newValue;

    let result;
    if (field.startsWith('cf:')) {
      const cfKey = field.slice(3).replace(/'/g, "''");
      if (clear) {
        result = await pool.query(
          `UPDATE contacts SET custom_fields = custom_fields - '${cfKey}', updated_at = NOW()
           WHERE custom_fields->>'${cfKey}' = ANY($1)`,
          [values]
        );
      } else {
        result = await pool.query(
          `UPDATE contacts SET custom_fields = jsonb_set(COALESCE(custom_fields, '{}'::jsonb), '{${cfKey}}', to_jsonb($1::text)), updated_at = NOW()
           WHERE custom_fields->>'${cfKey}' = ANY($2)`,
          [newValue, values]
        );
      }
    } else if (FILTERABLE_COLS.has(field)) {
      if (clear) {
        result = await pool.query(
          `UPDATE contacts SET ${field} = NULL, updated_at = NOW() WHERE ${field} = ANY($1)`,
          [values]
        );
      } else {
        result = await pool.query(
          `UPDATE contacts SET ${field} = $1, updated_at = NOW() WHERE ${field} = ANY($2)`,
          [newValue, values]
        );
      }
    } else {
      return res.status(400).json({ error: 'field not filterable' });
    }

    res.json({ ok: true, updated: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set the lead_category of a contact's reply for ONE specific campaign. This is what
// feeds the computed "Category" column, so marking a campaign as e.g. "Comprado" both
// shows up there and records WHICH campaign converted (the campaign_leads row keeps
// its campaign_name). This is a MANUAL edit, so it locks the row: automatic sources
// (webhooks, imports) will no longer overwrite the category. Clearing the category
// (empty) unlocks the row so automation can take over again.
app.post('/api/contacts/:email/campaign-category', auth, async (req, res) => {
  try {
    const { email } = req.params;
    const campaign_name = String(req.body?.campaign_name || '').trim();
    let category = String(req.body?.category ?? '').trim();
    if (!campaign_name) return res.status(400).json({ error: 'campaign_name required' });
    if (category.length > 100) category = category.slice(0, 100);
    const locked = !!category; // a real value locks it; clearing unlocks (back to auto)
    const result = await pool.query(
      `UPDATE campaign_leads SET lead_category = $1, category_locked = $2, updated_at = NOW()
       WHERE email = $3 AND campaign_name = $4`,
      [category || null, locked, email, campaign_name]
    );
    res.json({ ok: true, updated: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contacts/:email', auth, async (req, res) => {
  try {
    const { email } = req.params;
    const contact = await pool.query(`SELECT * FROM contacts WHERE email = $1`, [email]);
    if (!contact.rows.length) return res.status(404).json({ error: 'Not found' });

    const leads = await pool.query(
      `SELECT * FROM campaign_leads WHERE email = $1 ORDER BY replied_at DESC NULLS LAST`, [email]
    );
    const activity = await pool.query(
      `SELECT * FROM campaign_activity WHERE email = $1 ORDER BY sent_at DESC NULLS LAST`, [email]
    );
    const notesList = await pool.query(
      `SELECT * FROM notes WHERE email = $1 ORDER BY created_at DESC`, [email]
    );
    const tagsList = await pool.query(
      `SELECT t.id, t.name, t.color FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_email = $1 ORDER BY t.name`, [email]
    );

    res.json({ contact: contact.rows[0], campaign_leads: leads.rows, campaign_activity: activity.rows, notes: notesList.rows, tags: tagsList.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/contacts/:email — editar contacto
app.patch('/api/contacts/:email', auth, async (req, res) => {
  try {
    const { email } = req.params;
    const EDITABLE = ['first_name','last_name','first_name_cleaned','company','company_cleaned',
      'phone','job_title','department','industry','city','state','country','company_url',
      'linkedin_personal','linkedin_company','source','lead_category'];
    const updates = [];
    const vals = [];
    let p = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (EDITABLE.includes(k)) { updates.push(`${k} = $${p}`); vals.push(v || null); p++; }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields' });
    vals.push(email);
    await pool.query(`UPDATE contacts SET ${updates.join(', ')}, updated_at = NOW() WHERE email = $${p}`, vals);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a contact entirely. ON DELETE CASCADE removes its campaign_leads,
// campaign_activity, contact_tags and notes along with it.
app.delete('/api/contacts/:email', auth, async (req, res) => {
  try {
    const { email } = req.params;
    const r = await pool.query(`DELETE FROM contacts WHERE email = $1`, [email]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted: r.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change a contact's email (primary key). ON UPDATE CASCADE propagates the
// change to notes, campaign_leads, campaign_activity and contact_tags.
app.post('/api/contacts/:email/change-email', auth, async (req, res) => {
  try {
    const oldEmail = req.params.email;
    const newEmail = String(req.body.new_email || '').trim().toLowerCase();
    if (!newEmail) return res.status(400).json({ error: 'Falta el nuevo email' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail))
      return res.status(400).json({ error: 'Formato de email inválido' });
    if (newEmail === oldEmail.toLowerCase())
      return res.status(400).json({ error: 'El nuevo email es igual al actual' });

    const exists = await pool.query('SELECT 1 FROM contacts WHERE LOWER(email) = $1', [newEmail]);
    if (exists.rowCount) return res.status(409).json({ error: 'Ya existe un contacto con ese email' });

    const upd = await pool.query(
      'UPDATE contacts SET email = $1, updated_at = NOW() WHERE email = $2',
      [newEmail, oldEmail]
    );
    if (!upd.rowCount) return res.status(404).json({ error: 'Contacto no encontrado' });
    res.json({ ok: true, email: newEmail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// NOTES
// ═══════════════════════════════════════════════════════════
app.post('/api/notes', auth, async (req, res) => {
  try {
    const { email, note } = req.body;
    if (!email || !note) return res.status(400).json({ error: 'email and note required' });
    const result = await pool.query(
      `INSERT INTO notes (email, note) VALUES ($1,$2) RETURNING *`, [email, note]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notes/:id', auth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM notes WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// COMPANIES
// ═══════════════════════════════════════════════════════════
const CAMP_SORT = { campaign_name:'campaign_name', total_contacts:'total_contacts', interested:'interested' };
const COMP_SORT = { company:'company', total_contacts:'total_contacts', industry:'industry', city:'city' };

app.get('/api/companies', auth, async (req, res) => {
  try {
    const { search, sort_by = 'company', sort_dir = 'ASC', page = 1, limit = 20 } = req.query;
    const params = [];
    let where = `WHERE company IS NOT NULL AND company != ''`;
    if (search) { where += ` AND company ILIKE $1`; params.push(`%${search}%`); }
    const col = COMP_SORT[sort_by] || 'company';
    const dir = sort_dir === 'DESC' ? 'DESC' : 'ASC';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT company) AS total FROM contacts ${where}`, params
    );
    const result = await pool.query(`
      SELECT company,
        COUNT(*) AS total_contacts,
        STRING_AGG(DISTINCT NULLIF(industry,''), ', ') AS industry,
        STRING_AGG(DISTINCT NULLIF(city,''), ', ') AS city
      FROM contacts ${where}
      GROUP BY company
      ORDER BY ${col} ${dir} NULLS LAST
      LIMIT $${params.length+1} OFFSET $${params.length+2}
    `, [...params, parseInt(limit), offset]);
    res.json({ rows: result.rows, total: parseInt(countResult.rows[0].total) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Names reference view: distinct first names with their cleaned value + count
const NAME_SORT = { first_name: 'first_name', first_name_cleaned: 'MAX(first_name_cleaned)', total_contacts: 'total_contacts' };
app.get('/api/names', auth, async (req, res) => {
  try {
    const { search, sort_by = 'first_name', sort_dir = 'ASC', page = 1, limit = 20 } = req.query;
    const params = [];
    let where = `WHERE first_name IS NOT NULL AND first_name != ''`;
    if (search) { where += ` AND (first_name ILIKE $1 OR first_name_cleaned ILIKE $1)`; params.push(`%${search}%`); }
    const col = NAME_SORT[sort_by] || 'first_name';
    const dir = sort_dir === 'DESC' ? 'DESC' : 'ASC';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT first_name) AS total FROM contacts ${where}`, params
    );
    const result = await pool.query(`
      SELECT first_name,
        MAX(first_name_cleaned) AS first_name_cleaned,
        COUNT(*) AS total_contacts
      FROM contacts ${where}
      GROUP BY first_name
      ORDER BY ${col} ${dir} NULLS LAST
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, parseInt(limit), offset]);
    res.json({ rows: result.rows, total: parseInt(countResult.rows[0].total) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk-tag all contacts belonging to selected companies
app.post('/api/companies/bulk-tag', auth, async (req, res) => {
  try {
    const { companies, tag_id } = req.body;
    if (!companies?.length || !tag_id) return res.status(400).json({ error: 'companies and tag_id required' });
    const result = await pool.query(
      `SELECT email FROM contacts WHERE company = ANY($1)`, [companies]
    );
    let inserted = 0;
    for (const { email } of result.rows) {
      await pool.query(
        `INSERT INTO contact_tags (contact_email, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [email, tag_id]
      );
      inserted++;
    }
    res.json({ ok: true, contacts_tagged: inserted });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Detect companies with leading/trailing unwanted characters
app.get('/api/companies/preview-trim', auth, async (req, res) => {
  try {
    // chars: custom characters to trim (default: space + comma)
    const chars = req.query.chars ?? ' ,';
    const escaped = chars.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&');
    const trimRe = new RegExp(`^[${escaped}]+|[${escaped}]+$`, 'g');
    const result = await pool.query(
      `SELECT DISTINCT company FROM contacts WHERE company IS NOT NULL AND company != '' ORDER BY company`
    );
    const matches = result.rows
      .map(r => ({ old: r.company, updated: r.company.replace(trimRe, '') }))
      .filter(r => r.updated !== r.old && r.updated.length > 0);
    res.json(matches);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Apply trim to all affected companies
app.post('/api/companies/apply-trim', auth, async (req, res) => {
  try {
    const chars = req.body.chars ?? ' ,';
    const escaped = chars.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&');
    const trimRe = new RegExp(`^[${escaped}]+|[${escaped}]+$`, 'g');
    const result = await pool.query(
      `SELECT DISTINCT company FROM contacts WHERE company IS NOT NULL AND company != ''`
    );
    let updated = 0;
    for (const { company } of result.rows) {
      const cleaned = company.replace(trimRe, '');
      if (cleaned && cleaned !== company) {
        await pool.query(
          `UPDATE contacts SET company = $1, updated_at = NOW() WHERE company = $2`,
          [cleaned, company]
        );
        updated++;
      }
    }
    res.json({ ok: true, updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Preview which companies would change with a find/replace
app.get('/api/companies/preview-replace', auth, async (req, res) => {
  try {
    const { find, replace = '', case_sensitive = 'false' } = req.query;
    if (!find?.trim()) return res.status(400).json({ error: 'find is required' });
    const cs = case_sensitive === 'true';
    const result = await pool.query(
      `SELECT DISTINCT company FROM contacts WHERE company IS NOT NULL AND company != '' ORDER BY company`
    );
    const matches = result.rows
      .map(r => {
        const old = r.company;
        const pattern = cs ? find : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const updated = cs
          ? old.split(find).join(replace).trim()
          : old.replace(pattern, replace).trim();
        return updated !== old ? { old, updated } : null;
      })
      .filter(Boolean);
    res.json(matches);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Apply a find/replace to all matching company names
app.post('/api/companies/bulk-replace', auth, async (req, res) => {
  try {
    const { find, replace = '', case_sensitive = false, only } = req.body;
    if (!find?.trim()) return res.status(400).json({ error: 'find is required' });
    const cs = !!case_sensitive;
    const result = await pool.query(
      `SELECT DISTINCT company FROM contacts WHERE company IS NOT NULL AND company != ''`
    );
    let updated = 0;
    for (const { company } of result.rows) {
      // If 'only' list provided, skip companies not in that list
      if (Array.isArray(only) && !only.includes(company)) continue;
      const pattern = cs ? find : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const newName = cs
        ? company.split(find).join(replace).trim()
        : company.replace(pattern, replace).trim();
      if (newName !== company && newName.length > 0) {
        await pool.query(
          `UPDATE contacts SET company = $1, updated_at = NOW() WHERE company = $2`,
          [newName, company]
        );
        updated++;
      }
    }
    res.json({ ok: true, updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/companies/:name', auth, async (req, res) => {
  try {
    const oldName = decodeURIComponent(req.params.name);
    const { new_name } = req.body;
    if (!new_name?.trim()) return res.status(400).json({ error: 'new_name required' });
    const n = new_name.trim();
    const result = await pool.query(
      `UPDATE contacts SET company = $1, updated_at = NOW() WHERE company = $2`,
      [n, oldName]
    );
    res.json({ ok: true, updated: result.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
// CAMPAIGNS
// ═══════════════════════════════════════════════════════════
app.get('/api/campaigns', auth, async (req, res) => {
  try {
    const { search, sort_by = 'campaign_name', sort_dir = 'ASC' } = req.query;
    const params = [];
    let where = `WHERE campaign_name IS NOT NULL`;
    if (search) { where += ` AND campaign_name ILIKE $1`; params.push(`%${search}%`); }
    const col = CAMP_SORT[sort_by] || 'campaign_name';
    const dir = sort_dir === 'DESC' ? 'DESC' : 'ASC';
    const result = await pool.query(`
      SELECT
        campaign_name, campaign_id,
        COUNT(*) AS total_contacts,
        COUNT(*) FILTER (WHERE lead_category = 'Interested') AS interested
      FROM campaign_leads
      ${where}
      GROUP BY campaign_name, campaign_id
      ORDER BY ${col} ${dir} NULLS LAST
    `, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Category priority so a merge never drops the more meaningful state. Higher wins.
function catRankSQL(col) {
  return `CASE lower(coalesce(${col},''))
    WHEN '' THEN 0 WHEN 'comprado' THEN 100 WHEN 'interested' THEN 90
    WHEN 'meeting booked' THEN 88 WHEN 'meeting request' THEN 86
    WHEN 'information request' THEN 80 WHEN 'replied' THEN 70
    WHEN 'do not contact' THEN 50 WHEN 'not interested' THEN 48 WHEN 'wrong person' THEN 46
    WHEN 'out of office' THEN 30 WHEN 'opened' THEN 25 WHEN 'sent' THEN 15
    WHEN 'sender originated bounce' THEN 12 WHEN 'uncategorizable by ai' THEN 8 ELSE 5 END`;
}

// PATCH /api/campaigns/:name — rename a campaign, OR merge it into an existing one
// when the target name already exists (transactional). For contacts present in both
// campaigns we keep a single row with the best category (respecting a manual lock)
// plus any reply; duplicates are removed.
app.patch('/api/campaigns/:name', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const oldName = decodeURIComponent(req.params.name);
    const { new_name } = req.body;
    if (!new_name || !new_name.trim()) return res.status(400).json({ error: 'new_name required' });
    const n = new_name.trim();
    // Guard: merging a campaign into itself would delete every row. No-op instead.
    if (n === oldName) return res.json({ ok: true, old_name: oldName, new_name: n, updated: 0 });

    await client.query('BEGIN');
    // 1) Merge overlapping leads into the target, keeping the best fields.
    await client.query(`
      UPDATE campaign_leads t SET
        lead_category = CASE WHEN t.category_locked THEN t.lead_category
                             WHEN ${catRankSQL('s.lead_category')} > ${catRankSQL('t.lead_category')} THEN s.lead_category
                             ELSE t.lead_category END,
        category_locked = (t.category_locked OR s.category_locked),
        reply_message = COALESCE(t.reply_message, s.reply_message),
        replied_at    = COALESCE(t.replied_at, s.replied_at),
        sentiment     = COALESCE(t.sentiment, s.sentiment),
        history       = COALESCE(t.history, s.history),
        updated_at    = NOW()
      FROM campaign_leads s
      WHERE t.campaign_name = $1 AND s.campaign_name = $2 AND s.email = t.email`, [n, oldName]);
    // 2) Drop the now-merged duplicate rows, 3) rename the rest.
    await client.query(`DELETE FROM campaign_leads s WHERE s.campaign_name = $2
      AND EXISTS (SELECT 1 FROM campaign_leads t WHERE t.campaign_name = $1 AND t.email = s.email)`, [n, oldName]);
    const r1 = await client.query(`UPDATE campaign_leads SET campaign_name = $1 WHERE campaign_name = $2`, [n, oldName]);

    await client.query(`DELETE FROM campaign_activity s WHERE s.campaign_name = $2
      AND EXISTS (SELECT 1 FROM campaign_activity t WHERE t.campaign_name = $1 AND t.email = s.email
                  AND t.sequence_number IS NOT DISTINCT FROM s.sequence_number)`, [n, oldName]);
    const r2 = await client.query(`UPDATE campaign_activity SET campaign_name = $1 WHERE campaign_name = $2`, [n, oldName]);
    await client.query('COMMIT');

    res.json({ ok: true, old_name: oldName, new_name: n, updated: r1.rowCount + r2.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/campaigns/:name — remove a campaign's leads + activity (e.g. junk from
// webhook tests). Contacts are left intact since they may belong to other campaigns.
app.delete('/api/campaigns/:name', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const name = decodeURIComponent(req.params.name);
    await client.query('BEGIN');
    const a = await client.query(`DELETE FROM campaign_activity WHERE campaign_name = $1`, [name]);
    const l = await client.query(`DELETE FROM campaign_leads    WHERE campaign_name = $1`, [name]);
    await client.query('COMMIT');
    res.json({ ok: true, name, leads_deleted: l.rowCount, activity_deleted: a.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/campaigns/:name/replies — every reply received in a campaign, each with
// its label (lead_category) and the contact's tags. Reply text comes from
// campaign_leads, falling back to the latest campaign_activity reply for that
// contact+campaign.
app.get('/api/campaigns/:name/replies', auth, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const result = await pool.query(`
      SELECT
        cl.email,
        cl.lead_category,
        COALESCE(cl.replied_at, (
          SELECT MAX(ca.replied_at) FROM campaign_activity ca
          WHERE ca.email = cl.email AND ca.campaign_name = cl.campaign_name
            AND ca.reply_message IS NOT NULL AND ca.reply_message <> ''
        )) AS replied_at,
        COALESCE(NULLIF(cl.reply_message, ''), (
          SELECT ca.reply_message FROM campaign_activity ca
          WHERE ca.email = cl.email AND ca.campaign_name = cl.campaign_name
            AND ca.reply_message IS NOT NULL AND ca.reply_message <> ''
          ORDER BY ca.replied_at DESC NULLS LAST LIMIT 1
        )) AS reply_message,
        c.first_name, c.last_name, c.company, c.company_cleaned,
        (SELECT JSON_AGG(JSON_BUILD_OBJECT('name', t.name, 'color', t.color) ORDER BY t.name)
         FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
         WHERE ct.contact_email = cl.email) AS tags
      FROM campaign_leads cl
      LEFT JOIN contacts c ON c.email = cl.email
      WHERE cl.campaign_name = $1
        AND (
          (cl.reply_message IS NOT NULL AND cl.reply_message <> '')
          OR EXISTS (SELECT 1 FROM campaign_activity ca
                     WHERE ca.email = cl.email AND ca.campaign_name = cl.campaign_name
                       AND ca.reply_message IS NOT NULL AND ca.reply_message <> '')
        )
      ORDER BY replied_at DESC NULLS LAST, cl.email
    `, [name]);
    res.json({ campaign: name, replies: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════
app.get('/api/stats', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM contacts) AS total_contacts,
        (SELECT COUNT(DISTINCT email) FROM campaign_leads WHERE lead_category = 'Interested') AS total_interested,
        (SELECT COUNT(*) FROM contacts WHERE no_contact = TRUE) AS no_contact,
        (SELECT COUNT(*) FROM contacts WHERE email_bounced = TRUE) AS bounced,
        (SELECT COUNT(*) FROM contacts WHERE personalization_status = 'Ready') AS total_ready,
        (SELECT COUNT(*) FROM contacts WHERE personalization_status = 'Generic') AS total_generic,
        (SELECT COUNT(DISTINCT campaign_name) FROM campaign_leads WHERE campaign_name IS NOT NULL) AS total_campaigns
    `);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════
// Build the WHERE clause + params for contact filters (shared by export)
function buildContactsWhere(q) {
  const { search, campaign, category, no_contact, bounced, filters } = q;
  const params = [];
  const conditions = [];
  let p = 1;
  if (search) {
    conditions.push(`(c.email ILIKE $${p} OR c.first_name ILIKE $${p} OR c.last_name ILIKE $${p} OR c.company ILIKE $${p})`);
    params.push(`%${search}%`); p++;
  }
  if (campaign) {
    const campsArr = String(campaign).split('|||').map(s => s.trim()).filter(Boolean);
    const wantNoCampaign = campsArr.includes('__no_campaign__');
    const realCamps = campsArr.filter(c => c !== '__no_campaign__');
    const orParts = [];
    if (realCamps.length === 1) { orParts.push(`EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.email = c.email AND cl.campaign_name ILIKE $${p})`); params.push(`%${realCamps[0]}%`); p++; }
    else if (realCamps.length > 1) { orParts.push(`EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.email = c.email AND cl.campaign_name = ANY($${p}))`); params.push(realCamps); p++; }
    if (wantNoCampaign) orParts.push(`NOT EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.email = c.email)`);
    if (orParts.length) conditions.push('(' + orParts.join(' OR ') + ')');
  }
  if (category) {
    const catsArr = String(category).split('|||').map(s => s.trim()).filter(Boolean);
    if (catsArr.length === 1) { conditions.push(`EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.email = c.email AND cl.lead_category = $${p})`); params.push(catsArr[0]); p++; }
    else if (catsArr.length > 1) { conditions.push(`EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.email = c.email AND cl.lead_category = ANY($${p}))`); params.push(catsArr); p++; }
  }
  if (no_contact === 'true' || no_contact === true) conditions.push(`c.no_contact = TRUE`);
  if (bounced === 'true' || bounced === true) conditions.push(`c.email_bounced = TRUE`);
  if (filters) {
    try {
      const fArr = typeof filters === 'string' ? JSON.parse(filters) : filters;
      for (const f of fArr) {
        const isNull = f.op === 'empty';
        const notNull = f.op === 'not_empty';
        if (FILTERABLE_COLS.has(f.field)) {
          if (isNull) conditions.push(`(c.${f.field} IS NULL OR c.${f.field} = '')`);
          else if (notNull) conditions.push(`(c.${f.field} IS NOT NULL AND c.${f.field} != '')`);
          else if (f.value) {
            if (f.op === 'exact') { conditions.push(`LOWER(c.${f.field}) = LOWER($${p})`); params.push(f.value); p++; }
            else { conditions.push(`c.${f.field} ILIKE $${p}`); params.push(`%${f.value}%`); p++; }
          }
        }
        if (f.field && f.field.startsWith('cf:')) {
          const cfKey = f.field.slice(3).replace(/'/g, "''");
          if (isNull) conditions.push(`(c.custom_fields->>'${cfKey}' IS NULL OR c.custom_fields->>'${cfKey}' = '')`);
          else if (notNull) conditions.push(`(c.custom_fields->>'${cfKey}' IS NOT NULL AND c.custom_fields->>'${cfKey}' != '')`);
          else if (f.value) {
            if (f.op === 'exact') { conditions.push(`LOWER(c.custom_fields->>'${cfKey}') = LOWER($${p})`); params.push(f.value); p++; }
            else { conditions.push(`c.custom_fields->>'${cfKey}' ILIKE $${p}`); params.push(`%${f.value}%`); p++; }
          }
        }
        if (f.field === 'tag') {
          if (isNull) conditions.push(`NOT EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_email = c.email)`);
          else if (notNull) conditions.push(`EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_email = c.email)`);
          else if (f.value) {
            if (f.op === 'exact') { conditions.push(`EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_email = c.email AND LOWER(t.name) = LOWER($${p}))`); params.push(f.value); }
            else { conditions.push(`EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_email = c.email AND t.name ILIKE $${p})`); params.push(`%${f.value}%`); }
            p++;
          }
        }
      }
    } catch (_) {}
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

// Export contacts as CSV: by explicit emails (selection) or by current filters
app.post('/api/export', auth, async (req, res) => {
  try {
    const body = req.body || {};
    let where, params;
    if (Array.isArray(body.emails) && body.emails.length) {
      where = 'WHERE c.email = ANY($1)';
      params = [body.emails];
    } else {
      ({ where, params } = buildContactsWhere(body));
    }

    const result = await pool.query(`
      SELECT
        c.email, c.first_name, c.first_name_cleaned, c.last_name,
        c.company, c.company_cleaned, c.phone, c.job_title, c.department,
        c.industry, c.city, c.state, c.country, c.company_url,
        c.linkedin_personal, c.linkedin_company, c.source,
        (SELECT STRING_AGG(DISTINCT cl.campaign_name, ' | ') FROM campaign_leads cl WHERE cl.email = c.email) AS campaigns,
        (SELECT STRING_AGG(DISTINCT cl.lead_category, ', ') FROM campaign_leads cl WHERE cl.email = c.email) AS category,
        (SELECT STRING_AGG(DISTINCT t.name, ', ') FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_email = c.email) AS tags
      FROM contacts c
      ${where}
      ORDER BY c.email
    `, params);

    const headers = ['email','first_name','first_name_cleaned','last_name','company','company_cleaned','phone','job_title','department','industry','city','state','country','company_url','linkedin_personal','linkedin_company','source','campaigns','category','tags'];
    const csvRows = [headers.join(',')];
    for (const row of result.rows) {
      csvRows.push(headers.map(h => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts_export.csv"');
    res.send('﻿' + csvRows.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// IMPORT
// ═══════════════════════════════════════════════════════════
const CONTACT_FIELDS = new Set([
  'email','first_name','last_name','company','phone','job_title','department',
  'industry','city','state','country','company_url','linkedin_personal',
  'linkedin_company','source','lead_category',
  'first_name_cleaned','company_cleaned'
]);

const CAMPAIGN_LEAD_FIELDS = new Set([
  'email','campaign_name','campaign_id','lead_category','status','esp_type',
  'current_sequence','location','company_city','website','sentiment','reply_message','replied_at'
]);

const CAMPAIGN_ACTIVITY_FIELDS = new Set([
  'email','campaign_name','lead_name','sequence_number','sent_at','opened_at',
  'clicked_at','replied_at','reply_message','open_count','click_count','sent_email_body','is_unsubscribed'
]);

function toNull(v) { return v === '' || v === '--' || v === undefined ? null : v; }
function parseBool(v) { return String(v).toLowerCase() === 'true'; }

// ─── Data cleaning (server-side, used to clean existing contacts) ──────────
function fixEncoding(text) {
  if (!text) return text;
  const str = String(text);
  if (str.includes('Ã') || str.includes('Â') || str.includes('�')) {
    try { return Buffer.from(str, 'latin1').toString('utf8'); } catch { return str; }
  }
  return str;
}
function normalizeLegalSuffixes(text) {
  const replacements = [
    [/S\.?\s*A\.?\s*DE\s*C\.?\s*V\.?/gi, 'SA DE CV'],
    [/S\.?\s*DE\s*R\.?\s*L\.?\s*DE\s*C\.?\s*V\.?/gi, 'S DE RL DE CV'],
    [/S\.?\s*A\.?\s*P\.?\s*I\.?\s*DE\s*C\.?\s*V\.?/gi, 'SAPI DE CV'],
    [/S\.?\s*A\.?\s*B\.?\s*DE\s*C\.?\s*V\.?/gi, 'SAB DE CV'],
    [/SAB\s*DECV/gi, 'SAB DE CV'],
    [/S\.?\s*A\.?\s*P\.?\s*I\.?/gi, 'SAPI'],
    [/S\.?\s*COOP\.?/gi, 'S COOP'],
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return text;
}
function toTitleCase(str) {
  return str.toLowerCase().split(' ').map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(' ');
}
function preserveAcronyms(text) {
  const acronyms = ['BMW','IAC','IBM','ABB','DHL','UPS','GM','GE','HP','3M','CEMEX','BASF','TTI','JLG','CAT'];
  for (const a of acronyms) text = text.replace(new RegExp(`\\b${a}\\b`, 'i'), a);
  return text;
}
function cleanCompanyName(companyName) {
  if (!companyName) return '';
  let text = fixEncoding(String(companyName).trim());
  text = text.replace(/^https?:\/\/(www\.)?/i, '');
  text = text.replace(/\.(com\.mx|com|mx|net|org)$/i, '');
  text = text.split(' - ')[0];
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/\(.*?\)/g, '');
  text = text.replace(/,/g, ' ');
  const numericVersion = text.replace(/[^\d]/g, '');
  if (numericVersion.length >= 7 && /^[\d\s()+-]+$/.test(text)) return '';
  text = normalizeLegalSuffixes(text);
  const legalSuffixes = ['SA DE CV','S DE RL DE CV','SAPI DE CV','SAB DE CV','SAPI','S COOP','LLC','L.L.C','INC','INCORPORATED','CORPORATION','CORP','LIMITED','LTDA','SA','S A','S. A','S.A'];
  let changed = true;
  while (changed) {
    const original = text;
    for (const suffix of legalSuffixes) {
      text = text.replace(new RegExp(`(?:\\s|,)+${suffix.replace(/\./g, '\\.')}\\.?\\s*$`, 'i'), '').trim();
    }
    changed = original !== text;
  }
  const regionalSuffixes = ['MX','MEX','MEXICO','MÉXICO','USA','US'];
  for (const suffix of regionalSuffixes) {
    text = text.replace(new RegExp(`(?<!DE )\\b${suffix}\\b\\s*$`, 'i'), '').trim();
  }
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/^[\s\-_/.,;|]+|[\s\-_/.,;|]+$/g, '');
  text = toTitleCase(text);
  text = preserveAcronyms(text);
  return text;
}
const badNames = new Set(['Administracion','Administración','Comercio','Trafico','Tráfico','Logistica','Logística','Operaciones','Compras','Importacion','Importación','Importaciones','Exportacion','Exportación','Embarque','Recepcion','Recepción','Ventas','Recursos','Humanos','Admin','Info','Contacto','Usuario','Team','Customer','Service','Gerente','Finance','Accounting','Rh','Proteak','Ensambladores','Direccion','Dirección','Asistente','Auxiliar','Coordinacion','Coordinación','Gerencia','Departamento','Corporativo','Empresa','Facturacion','Facturación','Sistemas','Almacen','Almacén','Credito','Crédito','Cobranza','Atencion','Atención','Lic','Ing','Dr','Dra','Mtro','Mtra','Mttra','Cp','Arq','Sr','Sra','Srta','Licenciado','Ingeniero']);
function generateGreetingName(firstName, lastName) {
  if (!firstName) return null;
  let name = fixEncoding(String(firstName).trim());
  const last = fixEncoding(String(lastName || '')).trim().toLowerCase();
  if (name.toLowerCase() === 'a' && last.includes('quien')) return null;
  const titles = [/^Lic\.?\s+/i,/^Ing\.?\s+/i,/^Dr\.?\s+/i,/^Dra\.?\s+/i,/^Mtro\.?\s+/i,/^Mtra\.?\s+/i,/^Mttra\.?\s+/i,/^Cp\.?\s+/i,/^C\.?\s*P\.?\s+/i,/^Sr\.?\s+/i,/^Sra\.?\s+/i,/^Srta\.?\s+/i,/^Arq\.?\s+/i,/^Licenciado\s+/i,/^Ingeniero\s+/i];
  for (const p of titles) name = name.replace(p, '');
  if (/^(Lic|Ing|Dr|Dra|Mtro|Mtra|Mttra|Cp|Arq|Sr|Sra|Srta|Licenciado|Ingeniero)\.?$/i.test(name.trim())) return null;
  name = name.replace(/^[A-ZÁÉÍÓÚÑ]\.\s+/i, '');
  name = name.replace(/\s+/g, ' ').trim();
  if (!name) return null;
  name = toTitleCase(name);
  const greetingName = name.split(' ')[0];
  if (/^[A-ZÁÉÍÓÚÑ]\.$/i.test(greetingName)) return null;
  if (greetingName.length <= 1) return null;
  if (/\d/.test(greetingName)) return null;
  if (badNames.has(greetingName)) return null;
  return greetingName;
}

app.post('/api/import/contacts', auth, async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });
  let imported = 0, errors = 0;

  for (const row of rows) {
    if (!row.email) continue;
    const custom = {};
    for (const [k, v] of Object.entries(row)) {
      if (!CONTACT_FIELDS.has(k) && k !== 'email') custom[k] = v;
    }
    try {
      await pool.query(`
        INSERT INTO contacts (
          email, first_name, last_name, company, phone, job_title, department,
          industry, city, state, country, company_url, linkedin_personal,
          linkedin_company, source, lead_category,
          first_name_cleaned, company_cleaned, custom_fields
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (email) DO UPDATE SET
          first_name        = COALESCE(EXCLUDED.first_name, contacts.first_name),
          last_name         = COALESCE(EXCLUDED.last_name, contacts.last_name),
          company           = COALESCE(EXCLUDED.company, contacts.company),
          phone             = COALESCE(EXCLUDED.phone, contacts.phone),
          job_title         = COALESCE(EXCLUDED.job_title, contacts.job_title),
          department        = COALESCE(EXCLUDED.department, contacts.department),
          industry          = COALESCE(EXCLUDED.industry, contacts.industry),
          city              = COALESCE(EXCLUDED.city, contacts.city),
          state             = COALESCE(EXCLUDED.state, contacts.state),
          country           = COALESCE(EXCLUDED.country, contacts.country),
          company_url       = COALESCE(EXCLUDED.company_url, contacts.company_url),
          linkedin_personal = COALESCE(EXCLUDED.linkedin_personal, contacts.linkedin_personal),
          linkedin_company  = COALESCE(EXCLUDED.linkedin_company, contacts.linkedin_company),
          source            = COALESCE(EXCLUDED.source, contacts.source),
          lead_category     = COALESCE(EXCLUDED.lead_category, contacts.lead_category),
          first_name_cleaned = COALESCE(EXCLUDED.first_name_cleaned, contacts.first_name_cleaned),
          company_cleaned    = COALESCE(EXCLUDED.company_cleaned, contacts.company_cleaned),
          custom_fields     = contacts.custom_fields || EXCLUDED.custom_fields,
          updated_at        = NOW()
      `, [
        row.email,
        toNull(row.first_name), toNull(row.last_name), toNull(row.company),
        toNull(row.phone), toNull(row.job_title), toNull(row.department),
        toNull(row.industry), toNull(row.city), toNull(row.state),
        toNull(row.country), toNull(row.company_url), toNull(row.linkedin_personal),
        toNull(row.linkedin_company), toNull(row.source), toNull(row.lead_category),
        toNull(row.first_name_cleaned), toNull(row.company_cleaned), JSON.stringify(custom)
      ]);
      imported++;
    } catch (e) {
      console.error('import/contacts error:', e.message, row.email);
      errors++;
    }
  }
  res.json({ ok: true, imported, errors });
});

// Recompute first_name_cleaned / company_cleaned for ALL existing contacts
app.post('/api/contacts/clean-all', auth, async (req, res) => {
  try {
    const doCompany = req.body.company !== false;
    const doName = req.body.name !== false;
    const all = await pool.query('SELECT id, first_name, last_name, company FROM contacts');
    const rows = all.rows;
    let updated = 0;
    const BATCH = 1000;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const ids = [], fncs = [], ccs = [];
      for (const r of slice) {
        ids.push(r.id);
        fncs.push(doName ? generateGreetingName(r.first_name, r.last_name) : null);
        ccs.push(doCompany ? (cleanCompanyName(r.company) || null) : null);
      }
      await pool.query(
        `UPDATE contacts c SET
           first_name_cleaned = CASE WHEN $4 THEN d.fnc ELSE c.first_name_cleaned END,
           company_cleaned    = CASE WHEN $5 THEN d.cc  ELSE c.company_cleaned END,
           updated_at = NOW()
         FROM (SELECT UNNEST($1::int[]) id, UNNEST($2::text[]) fnc, UNNEST($3::text[]) cc) d
         WHERE c.id = d.id`,
        [ids, fncs, ccs, doName, doCompany]
      );
      updated += slice.length;
    }
    res.json({ ok: true, updated });
  } catch (err) {
    console.error('clean-all error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/import/campaign-leads', auth, async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });
  let imported = 0, errors = 0;

  for (const row of rows) {
    if (!row.email || !row.campaign_name) continue;
    const custom = {};
    for (const [k, v] of Object.entries(row)) {
      if (!CAMPAIGN_LEAD_FIELDS.has(k)) custom[k] = v;
    }
    try {
      // Ensure contact exists
      await pool.query(
        `INSERT INTO contacts (email, first_name, last_name, company, phone, job_title, department, industry, city, country, company_url, linkedin_personal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (email) DO UPDATE SET
           first_name  = COALESCE(EXCLUDED.first_name, contacts.first_name),
           last_name   = COALESCE(EXCLUDED.last_name, contacts.last_name),
           company     = COALESCE(EXCLUDED.company, contacts.company),
           phone       = COALESCE(EXCLUDED.phone, contacts.phone),
           job_title   = COALESCE(EXCLUDED.job_title, contacts.job_title),
           department  = COALESCE(EXCLUDED.department, contacts.department),
           industry    = COALESCE(EXCLUDED.industry, contacts.industry),
           city        = COALESCE(EXCLUDED.city, contacts.city),
           country     = COALESCE(EXCLUDED.country, contacts.country),
           company_url = COALESCE(EXCLUDED.company_url, contacts.company_url),
           linkedin_personal = COALESCE(EXCLUDED.linkedin_personal, contacts.linkedin_personal),
           updated_at  = NOW()`,
        [row.email, toNull(row.first_name), toNull(row.last_name), toNull(row.company),
         toNull(row.phone), toNull(row.job_title), toNull(row.department),
         toNull(row.industry), toNull(row.city), toNull(row.country),
         toNull(row.company_url), toNull(row.linkedin_personal)]
      );

      await pool.query(`
        INSERT INTO campaign_leads
          (email, campaign_name, campaign_id, lead_category, status, esp_type,
           current_sequence, location, company_city, website, custom_fields)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (email, campaign_name) DO UPDATE SET
          lead_category    = CASE WHEN campaign_leads.category_locked
                             THEN campaign_leads.lead_category
                             ELSE COALESCE(EXCLUDED.lead_category, campaign_leads.lead_category) END,
          status           = COALESCE(EXCLUDED.status, campaign_leads.status),
          esp_type         = COALESCE(EXCLUDED.esp_type, campaign_leads.esp_type),
          current_sequence = COALESCE(EXCLUDED.current_sequence, campaign_leads.current_sequence),
          location         = COALESCE(EXCLUDED.location, campaign_leads.location),
          company_city     = COALESCE(EXCLUDED.company_city, campaign_leads.company_city),
          website          = COALESCE(EXCLUDED.website, campaign_leads.website),
          custom_fields    = campaign_leads.custom_fields || EXCLUDED.custom_fields,
          updated_at       = NOW()
      `, [
        row.email, row.campaign_name, toNull(row.campaign_id), toNull(row.lead_category),
        toNull(row.status), toNull(row.esp_type), toNull(row.current_sequence),
        toNull(row.location), toNull(row.company_city), toNull(row.website),
        JSON.stringify(custom)
      ]);
      imported++;
    } catch (e) {
      console.error('import/campaign-leads error:', e.message, row.email);
      errors++;
    }
  }
  res.json({ ok: true, imported, errors });
});

app.post('/api/import/campaign-activity', auth, async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });
  let imported = 0, errors = 0;

  for (const row of rows) {
    if (!row.email || !row.campaign_name || !row.sequence_number) continue;
    try {
      // Ensure contact exists
      await pool.query(
        `INSERT INTO contacts (email, first_name) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING`,
        [row.email, toNull(row.lead_name)]
      );

      await pool.query(`
        INSERT INTO campaign_activity
          (email, campaign_name, lead_name, sequence_number, sent_at, opened_at,
           clicked_at, replied_at, reply_message, open_count, click_count,
           sent_email_body, is_unsubscribed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (email, campaign_name, sequence_number) DO UPDATE SET
          sent_at         = COALESCE(EXCLUDED.sent_at, campaign_activity.sent_at),
          opened_at       = COALESCE(EXCLUDED.opened_at, campaign_activity.opened_at),
          clicked_at      = COALESCE(EXCLUDED.clicked_at, campaign_activity.clicked_at),
          replied_at      = COALESCE(EXCLUDED.replied_at, campaign_activity.replied_at),
          reply_message   = COALESCE(EXCLUDED.reply_message, campaign_activity.reply_message),
          open_count      = GREATEST(EXCLUDED.open_count, campaign_activity.open_count),
          click_count     = GREATEST(EXCLUDED.click_count, campaign_activity.click_count),
          is_unsubscribed = EXCLUDED.is_unsubscribed
      `, [
        row.email, row.campaign_name, toNull(row.lead_name), row.sequence_number,
        toNull(row.sent_at), toNull(row.opened_at), toNull(row.clicked_at),
        toNull(row.replied_at), toNull(row.reply_message),
        parseInt(row.open_count) || 0, parseInt(row.click_count) || 0,
        toNull(row.sent_email_body), parseBool(row.is_unsubscribed)
      ]);

      // Also register the lead in campaign_leads so the campaign shows up in the
      // Campaigns tab and its replies are visible. Infer a category from this
      // row's signals; the upsert never downgrades an existing higher category.
      const hasReply = (row.reply_message && String(row.reply_message).trim()) || row.replied_at;
      const hasOpen  = row.opened_at || (parseInt(row.open_count) || 0) > 0;
      const cat = hasReply ? 'Replied' : (hasOpen ? 'Opened' : 'Sent');
      await pool.query(`
        INSERT INTO campaign_leads (email, campaign_name, lead_category, reply_message, replied_at)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (email, campaign_name) DO UPDATE SET
          lead_category = CASE
            WHEN campaign_leads.category_locked THEN campaign_leads.lead_category
            WHEN campaign_leads.lead_category IN ('Interested','Replied','Comprado') THEN campaign_leads.lead_category
            WHEN EXCLUDED.lead_category = 'Replied' THEN 'Replied'
            WHEN campaign_leads.lead_category = 'Opened' OR EXCLUDED.lead_category = 'Opened' THEN 'Opened'
            ELSE COALESCE(campaign_leads.lead_category, EXCLUDED.lead_category) END,
          reply_message = COALESCE(EXCLUDED.reply_message, campaign_leads.reply_message),
          replied_at    = COALESCE(EXCLUDED.replied_at, campaign_leads.replied_at),
          updated_at    = NOW()
      `, [row.email, row.campaign_name, cat, toNull(row.reply_message), toNull(row.replied_at)]);
      imported++;
    } catch (e) {
      console.error('import/campaign-activity error:', e.message, row.email);
      errors++;
    }
  }
  res.json({ ok: true, imported, errors });
});

// ═══════════════════════════════════════════════════════════
// TAGS
// ═══════════════════════════════════════════════════════════
app.get('/api/tags', auth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM tags ORDER BY name`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tags', auth, async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const result = await pool.query(
      `INSERT INTO tags (name, color) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color RETURNING *`,
      [name.trim(), color || '#5b6af0']
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/tags/:id', auth, async (req, res) => {
  try {
    const { name, color } = req.body;
    const sets = [], vals = [];
    let p = 1;
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'name required' });
      sets.push(`name = $${p++}`); vals.push(String(name).trim());
    }
    if (color !== undefined) { sets.push(`color = $${p++}`); vals.push(color); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(req.params.id);
    const result = await pool.query(
      `UPDATE tags SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`, vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Tag not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un tag con ese nombre' });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tags/:id', auth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM tags WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contacts/bulk-tag', auth, async (req, res) => {
  try {
    const { emails, tag_id } = req.body;
    if (!Array.isArray(emails) || !tag_id) return res.status(400).json({ error: 'emails[] and tag_id required' });
    if (!emails.length) return res.json({ ok: true, inserted: 0 });
    const r = await pool.query(
      `INSERT INTO contact_tags (contact_email, tag_id)
       SELECT e, $2 FROM UNNEST($1::text[]) AS e
       ON CONFLICT DO NOTHING`,
      [emails, tag_id]
    );
    res.json({ ok: true, inserted: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contacts/:email/tags', auth, async (req, res) => {
  try {
    const { tag_id } = req.body;
    await pool.query(
      `INSERT INTO contact_tags (contact_email, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.email, tag_id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/contacts/:email/tags/:tagId', auth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM contact_tags WHERE contact_email = $1 AND tag_id = $2`,
      [req.params.email, req.params.tagId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════

const ENCODING_FIXES = [
  ['Ã¡', 'á'],  // á
  ['Ã©', 'é'],  // é
  ['Ã­', 'í'],  // í  (also covers soft-hyphen artifact GarcÃ­a)
  ['Ã³', 'ó'],  // ó
  ['Ãº', 'ú'],  // ú
  ['Ã±', 'ñ'],  // ñ
  ['Ã', 'É'],  // É
  ['Ã', 'Ó'],  // Ó
  ['Ã', 'Ú'],  // Ú
  ['Ã', 'Ñ'],  // Ñ
  ['Ã¼', 'ü'], ['Ã¤', 'ä'], ['Ã¶', 'ö'],
  ['Ã', 'Ç'], ['Ã§', 'ç'],
  ['Â¿', '¿'], ['Â¡', '¡'], ['Â«', '«'], ['Â»', '»'],
];

const ENCODING_TARGETS = [
  { table: 'contacts',          pk: ['email'],                                   cols: ['first_name','last_name','company','city','state','country','industry','job_title','department'] },
  { table: 'campaign_activity', pk: ['email','campaign_name','sequence_number'], cols: ['lead_name'] },
];

function applyEncodingFixes(str) {
  if (!str) return str;
  let s = str;
  for (const [bad, good] of ENCODING_FIXES) s = s.split(bad).join(good);
  return s;
}

function hasBrokenEncoding(str) {
  if (!str) return false;
  return ENCODING_FIXES.some(([bad]) => str.includes(bad));
}

app.get('/api/admin/preview-encoding', auth, async (req, res) => {
  try {
    const affected = {};
    let totalRows = 0;
    const samples = [];

    for (const { table, pk, cols } of ENCODING_TARGETS) {
      const rows = await pool.query('SELECT ' + [...pk, ...cols].join(',') + ' FROM ' + table);
      const bad = rows.rows.filter(r => cols.some(c => hasBrokenEncoding(r[c])));
      affected[table] = bad.length;
      totalRows += bad.length;
      for (const row of bad.slice(0, 5)) {
        const before = cols.map(c => row[c]).filter(Boolean).join(' | ');
        const after  = cols.map(c => applyEncodingFixes(row[c])).filter(Boolean).join(' | ');
        if (before !== after) samples.push({ table, before, after });
      }
    }

    res.json({ affected, totalRows, samples });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/fix-encoding', auth, async (req, res) => {
  try {
    const results = {};

    for (const { table, pk, cols } of ENCODING_TARGETS) {
      const rows = await pool.query('SELECT ' + [...pk, ...cols].join(',') + ' FROM ' + table);
      const toFix = rows.rows.filter(r => cols.some(c => hasBrokenEncoding(r[c])));
      let updated = 0;

      for (const row of toFix) {
        const sets = [];
        const params = [];
        let i = 1;
        for (const col of cols) {
          const fixed = applyEncodingFixes(row[col]);
          if (fixed !== row[col]) { sets.push(col + ' = $' + i++); params.push(fixed); }
        }
        if (!sets.length) continue;
        const where = pk.map((k, j) => k + ' = $' + (i + j)).join(' AND ');
        pk.forEach(k => params.push(row[k]));
        await pool.query('UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE ' + where, params);
        updated++;
      }
      results[table] = updated;
    }

    res.json({ ok: true, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// Export conflicts: rows where company and custom field are both non-empty and different
app.get('/api/admin/company-conflict-csv', auth, async (req, res) => {
  try {
    const cfKey = (req.query.cf_key || 'nombre de empresa').replace(/'/g, "''");
    const result = await pool.query(`
      SELECT email,
             company,
             custom_fields->>'${cfKey}' AS cf_val
      FROM contacts
      WHERE company IS NOT NULL AND company != ''
        AND custom_fields->>'${cfKey}' IS NOT NULL
        AND custom_fields->>'${cfKey}' != ''
        AND LOWER(company) != LOWER(custom_fields->>'${cfKey}')
      ORDER BY company
    `);

    const esc = v => '"' + String(v||'').replace(/"/g, '""') + '"';
    const lines = [
      ['Email', 'Company (campo estándar)', 'Nombre de empresa (custom field)'].map(esc).join(','),
      ...result.rows.map(r => [r.email, r.company, r.cf_val].map(esc).join(','))
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="company_conflicts.csv"');
    res.send('﻿' + lines.join('\r\n')); // BOM for Excel UTF-8
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Preview: count rows affected by each step of the company coalesce migration
app.get('/api/admin/preview-company-merge', auth, async (req, res) => {
  try {
    const cfKey = req.query.cf_key || 'nombre de empresa';

    const sameValue = await pool.query(`
      SELECT COUNT(*) AS total FROM contacts
      WHERE custom_fields->>'${cfKey.replace(/'/g,"''")}' IS NOT NULL
        AND custom_fields->>'${cfKey.replace(/'/g,"''")}' != ''
        AND company IS NOT NULL AND company != ''
        AND LOWER(company) = LOWER(custom_fields->>'${cfKey.replace(/'/g,"''")}')
    `);

    const copyToCompany = await pool.query(`
      SELECT COUNT(*) AS total FROM contacts
      WHERE (company IS NULL OR company = '')
        AND custom_fields->>'${cfKey.replace(/'/g,"''")}' IS NOT NULL
        AND custom_fields->>'${cfKey.replace(/'/g,"''")}' != ''
    `);

    const remaining = await pool.query(`
      SELECT COUNT(*) AS total FROM contacts
      WHERE custom_fields->>'${cfKey.replace(/'/g,"''")}' IS NOT NULL
        AND custom_fields->>'${cfKey.replace(/'/g,"''")}' != ''
        AND (company IS NULL OR company = '' OR LOWER(company) != LOWER(custom_fields->>'${cfKey.replace(/'/g,"''")}'))
        AND NOT ((company IS NULL OR company = '') AND custom_fields->>'${cfKey.replace(/'/g,"''")}' IS NOT NULL)
    `);

    // Samples
    const samples = await pool.query(`
      SELECT email, company, custom_fields->>'${cfKey.replace(/'/g,"''")}' AS cf_val
      FROM contacts
      WHERE custom_fields->>'${cfKey.replace(/'/g,"''")}' IS NOT NULL
        AND custom_fields->>'${cfKey.replace(/'/g,"''")}' != ''
      LIMIT 8
    `);

    res.json({
      step1_same_value:   parseInt(sameValue.rows[0].total),
      step2_copy_company: parseInt(copyToCompany.rows[0].total),
      remaining_conflict: parseInt(remaining.rows[0].total),
      samples: samples.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Apply the company coalesce migration
app.post('/api/admin/apply-company-merge', auth, async (req, res) => {
  try {
    const cfKey = (req.body.cf_key || 'nombre de empresa').replace(/'/g, "''");

    // Step 1: same value (case-insensitive) → remove from custom_fields
    const step1 = await pool.query(`
      UPDATE contacts
      SET custom_fields = custom_fields - '${cfKey}',
          updated_at = NOW()
      WHERE custom_fields->>'${cfKey}' IS NOT NULL
        AND custom_fields->>'${cfKey}' != ''
        AND company IS NOT NULL AND company != ''
        AND LOWER(company) = LOWER(custom_fields->>'${cfKey}')
    `);

    // Step 2: company empty → copy from custom field, then remove it
    const step2 = await pool.query(`
      UPDATE contacts
      SET company = custom_fields->>'${cfKey}',
          custom_fields = custom_fields - '${cfKey}',
          updated_at = NOW()
      WHERE (company IS NULL OR company = '')
        AND custom_fields->>'${cfKey}' IS NOT NULL
        AND custom_fields->>'${cfKey}' != ''
    `);

    res.json({
      ok: true,
      step1_cleaned: step1.rowCount,
      step2_merged:  step2.rowCount,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Promote company_cleaned to be the official company value.
// The previous company is saved into company_backup (first run only) so it can be restored.
// Body: { dryRun: true } returns the count without changing anything.
app.post('/api/admin/promote-company-cleaned', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const dryRun = req.body && req.body.dryRun === true;
    const count = await client.query(`
      SELECT COUNT(*)::int AS n FROM contacts
      WHERE company_cleaned IS NOT NULL AND company_cleaned != ''
        AND company IS DISTINCT FROM company_cleaned
    `);
    if (dryRun) return res.json({ ok: true, dryRun: true, wouldUpdate: count.rows[0].n });

    await client.query('BEGIN');
    await client.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_backup VARCHAR(255)`);
    await client.query(`
      UPDATE contacts SET company_backup = company
      WHERE company_backup IS NULL AND company IS NOT NULL
        AND company_cleaned IS NOT NULL AND company_cleaned != ''
        AND company IS DISTINCT FROM company_cleaned
    `);
    const upd = await client.query(`
      UPDATE contacts SET company = company_cleaned, updated_at = NOW()
      WHERE company_cleaned IS NOT NULL AND company_cleaned != ''
        AND company IS DISTINCT FROM company_cleaned
    `);
    await client.query('COMMIT');
    res.json({ ok: true, updated: upd.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Clear every company_cleaned value (set to NULL). The previous value is saved into
// company_cleaned_backup (first run only) so it can be restored.
// Body: { dryRun: true } returns the count without changing anything.
app.post('/api/admin/clear-company-cleaned', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const dryRun = req.body && req.body.dryRun === true;
    const count = await client.query(`
      SELECT COUNT(*)::int AS n FROM contacts
      WHERE company_cleaned IS NOT NULL AND company_cleaned != ''
    `);
    if (dryRun) return res.json({ ok: true, dryRun: true, wouldClear: count.rows[0].n });

    await client.query('BEGIN');
    await client.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_cleaned_backup VARCHAR(255)`);
    await client.query(`
      UPDATE contacts SET company_cleaned_backup = company_cleaned
      WHERE company_cleaned_backup IS NULL
        AND company_cleaned IS NOT NULL AND company_cleaned != ''
    `);
    const upd = await client.query(`
      UPDATE contacts SET company_cleaned = NULL, updated_at = NOW()
      WHERE company_cleaned IS NOT NULL AND company_cleaned != ''
    `);
    await client.query('COMMIT');
    res.json({ ok: true, cleared: upd.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Rebuild the generated personalization_status column so it depends on `company`
// instead of `company_cleaned`. Generated-column expressions can't be altered in
// place, so the column is dropped and recreated (no data loss — it's derived).
app.post('/api/admin/rebuild-personalization-status', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE contacts DROP COLUMN IF EXISTS personalization_status`);
    await client.query(`
      ALTER TABLE contacts ADD COLUMN personalization_status TEXT GENERATED ALWAYS AS (
        CASE WHEN first_name_cleaned IS NOT NULL AND first_name_cleaned <> ''
                  AND company IS NOT NULL AND company <> ''
             THEN 'Ready' ELSE 'Generic' END
      ) STORED
    `);
    await client.query('COMMIT');
    const dist = await client.query(`
      SELECT personalization_status AS status, COUNT(*)::int AS n
      FROM contacts GROUP BY personalization_status
    `);
    res.json({ ok: true, distribution: dist.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Permanently remove one or more custom_fields keys from every contact.
// The removed key/value pairs are copied into custom_fields_backup first.
// Body: { keys: string[], dryRun?: true }
app.post('/api/admin/delete-custom-fields', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const keys = Array.isArray(req.body.keys) ? req.body.keys.filter(k => typeof k === 'string' && k) : [];
    if (!keys.length) return res.status(400).json({ error: 'keys[] required' });
    const dryRun = req.body.dryRun === true;

    const perKey = await client.query(
      `SELECT k AS key, COUNT(*)::int AS n
         FROM contacts, unnest($1::text[]) k
        WHERE custom_fields ? k
        GROUP BY k ORDER BY k`, [keys]);
    if (dryRun) return res.json({ ok: true, dryRun: true, perKey: perKey.rows });

    await client.query('BEGIN');
    await client.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS custom_fields_backup JSONB DEFAULT '{}'::jsonb`);
    await client.query(`
      UPDATE contacts
      SET custom_fields_backup = COALESCE(custom_fields_backup, '{}'::jsonb) || COALESCE(
            (SELECT jsonb_object_agg(k, custom_fields->k)
               FROM unnest($1::text[]) k
              WHERE custom_fields ? k), '{}'::jsonb)
      WHERE custom_fields ?| $1::text[]`, [keys]);
    const upd = await client.query(`
      UPDATE contacts
      SET custom_fields = custom_fields - $1::text[], updated_at = NOW()
      WHERE custom_fields ?| $1::text[]`, [keys]);
    await client.query('COMMIT');
    res.json({ ok: true, contactsUpdated: upd.rowCount, perKey: perKey.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── Catch-all frontend ────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

app.listen(PORT, () => console.log(`CRM Labora running on port ${PORT}`));
