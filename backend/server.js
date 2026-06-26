require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
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
app.post('/webhook/smartlead', async (req, res) => {
  const payload = req.body;
  const eventType = payload.event_type;

  try {
    const email = payload.lead_email || payload.to_email;
    if (!email) return res.json({ ok: true, msg: 'no email' });

    const ignored = ['CAMPAIGN_STATUS_CHANGED', 'UNTRACKED_REPLIES', 'MANUAL_STEP_REACHED', 'EMAIL_LINK_CLICK'];
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
            lead_category = EXCLUDED.lead_category,
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
            lead_category = CASE WHEN campaign_leads.lead_category IN ('Interested','Replied')
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

// ═══════════════════════════════════════════════════════════
// CONTACTS
// ═══════════════════════════════════════════════════════════
const SORTABLE_COLS = {
  'email': 'c.email', 'first_name': 'c.first_name', 'last_name': 'c.last_name',
  'company': 'c.company', 'industry': 'c.industry', 'city': 'c.city',
  'last_activity': 'last_activity', 'created_at': 'c.created_at',
  'total_campaigns': 'total_campaigns',
};

const FILTERABLE_COLS = new Set(['company','industry','city','state','country','source','job_title','department','phone']);

app.get('/api/contacts', auth, async (req, res) => {
  try {
    const { search, campaign, category, no_contact, bounced, page = 1, limit = 50, sort_by = 'email', sort_dir = 'ASC', filters } = req.query;
    const offset = (page - 1) * limit;
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
      if (campsArr.length === 1) {
        conditions.push(`EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.email = c.email AND cl.campaign_name ILIKE $${p})`);
        params.push(`%${campsArr[0]}%`); p++;
      } else if (campsArr.length > 1) {
        conditions.push(`EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.email = c.email AND cl.campaign_name = ANY($${p}))`);
        params.push(campsArr); p++;
      }
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
    // op: 'contains' | 'exact' | 'empty' | 'not_empty'
    if (filters) {
      try {
        const fArr = JSON.parse(filters);
        for (const f of fArr) {
          const isNull  = f.op === 'empty';
          const notNull = f.op === 'not_empty';

          if (FILTERABLE_COLS.has(f.field)) {
            if (isNull) {
              conditions.push(`(c.${f.field} IS NULL OR c.${f.field} = '')`);
            } else if (notNull) {
              conditions.push(`(c.${f.field} IS NOT NULL AND c.${f.field} != '')`);
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
            } else if (f.value) {
              if (f.op === 'exact') {
                conditions.push(`EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_email = c.email AND LOWER(t.name) = LOWER($${p}))`);
                params.push(f.value);
              } else {
                conditions.push(`EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_email = c.email AND t.name ILIKE $${p})`);
                params.push(`%${f.value}%`);
              }
              p++;
            }
          }
        }
      } catch (_) {}
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderCol = SORTABLE_COLS[sort_by] || 'c.email';
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
      LIMIT $${p} OFFSET $${p+1}
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
    const EDITABLE = ['first_name','last_name','company','phone','job_title','department',
      'industry','city','state','country','company_url','linkedin_personal','linkedin_company','source','lead_category'];
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

// PATCH /api/campaigns/:name — rename campaign across all tables
app.patch('/api/campaigns/:name', auth, async (req, res) => {
  try {
    const oldName = decodeURIComponent(req.params.name);
    const { new_name } = req.body;
    if (!new_name || !new_name.trim()) return res.status(400).json({ error: 'new_name required' });
    const n = new_name.trim();
    await pool.query(`UPDATE campaign_leads    SET campaign_name = $1 WHERE campaign_name = $2`, [n, oldName]);
    await pool.query(`UPDATE campaign_activity SET campaign_name = $1 WHERE campaign_name = $2`, [n, oldName]);
    res.json({ ok: true, old_name: oldName, new_name: n });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
app.get('/api/export', auth, async (req, res) => {
  try {
    const { campaign, category } = req.query;
    const params = [];
    const conditions = [];
    let p = 1;

    if (campaign) { conditions.push(`cl.campaign_name ILIKE $${p}`); params.push(`%${campaign}%`); p++; }
    if (category) { conditions.push(`cl.lead_category = $${p}`); params.push(category); p++; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(`
      SELECT DISTINCT
        c.email, c.first_name, c.last_name, c.company, c.phone, c.job_title,
        c.industry, c.city, c.state,
        cl.campaign_name AS campaign, cl.lead_category AS category, cl.replied_at
      FROM contacts c
      JOIN campaign_leads cl ON cl.email = c.email
      ${where}
      ORDER BY cl.replied_at DESC NULLS LAST
    `, params);

    const headers = ['email','first_name','last_name','company','phone','job_title','industry','city','state','campaign','category','replied_at'];
    const csvRows = [headers.join(',')];
    for (const row of result.rows) {
      csvRows.push(headers.map(h => `"${String(row[h] || '').replace(/"/g, '""')}"`).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="export.csv"');
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
  'linkedin_company','source','lead_category','elv_result','elv_esp'
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
          linkedin_company, source, lead_category, elv_result, elv_esp, custom_fields
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
          elv_result        = COALESCE(EXCLUDED.elv_result, contacts.elv_result),
          elv_esp           = COALESCE(EXCLUDED.elv_esp, contacts.elv_esp),
          custom_fields     = contacts.custom_fields || EXCLUDED.custom_fields,
          updated_at        = NOW()
      `, [
        row.email,
        toNull(row.first_name), toNull(row.last_name), toNull(row.company),
        toNull(row.phone), toNull(row.job_title), toNull(row.department),
        toNull(row.industry), toNull(row.city), toNull(row.state),
        toNull(row.country), toNull(row.company_url), toNull(row.linkedin_personal),
        toNull(row.linkedin_company), toNull(row.source), toNull(row.lead_category),
        toNull(row.elv_result), toNull(row.elv_esp), JSON.stringify(custom)
      ]);
      imported++;
    } catch (e) {
      console.error('import/contacts error:', e.message, row.email);
      errors++;
    }
  }
  res.json({ ok: true, imported, errors });
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
          lead_category    = COALESCE(EXCLUDED.lead_category, campaign_leads.lead_category),
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
    let inserted = 0;
    for (const email of emails) {
      await pool.query(
        `INSERT INTO contact_tags (contact_email, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [email, tag_id]
      );
      inserted++;
    }
    res.json({ ok: true, inserted });
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

// ─── Catch-all frontend ────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

app.listen(PORT, () => console.log(`CRM Labora running on port ${PORT}`));
