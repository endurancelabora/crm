// ============================================================
// CRM Labora - Script de carga inicial
// Uso: node import-data.js
// Requiere: DATABASE_URL y API_KEY en .env
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const XLSX = require('xlsx');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false } : false
});

// ── Rutas de los archivos ──────────────────────────────────
const MASTER_SHEET = path.join(__dirname, '../..', 'Campañas SmartLead', 'Bases Finales', 'Master Sheet Labora 2026.xlsx');
const LEAD_LIST    = path.join(__dirname, '../..', 'Campañas SmartLead', 'Bases Finales', 'Todas_las_Campañas_Lead_List.csv');
const REPORT       = path.join(__dirname, '../..', 'Campañas SmartLead', 'Bases Finales', 'Todas_las_Campañas_Report.csv');

// ── Helpers ────────────────────────────────────────────────
function toNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' || s === '--' || s === 'N/A' ? null : s;
}

function parseBool(v) {
  return String(v).toLowerCase() === 'true';
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const headers = parseCSVRow(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCSVRow(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  }).filter(r => Object.values(r).some(v => v));
}

function parseCSVRow(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += c;
  }
  result.push(cur);
  return result;
}

// ── Upsert en lotes ───────────────────────────────────────
async function runBatch(fn, rows, batchSize = 100) {
  let ok = 0, err = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    for (const row of batch) {
      try { await fn(row); ok++; }
      catch (e) { err++; if (err <= 5) console.error('  Error:', e.message, '→', row.email || JSON.stringify(row).slice(0, 60)); }
    }
    process.stdout.write(`\r  ${i + batch.length}/${rows.length} processed...`);
  }
  console.log(`\r  ✅ ${ok} imported, ${err} errors`);
}

// ── 1. Master Sheet → contacts ─────────────────────────────
async function importMasterSheet() {
  console.log('\n📋 Importing Master Sheet...');
  if (!fs.existsSync(MASTER_SHEET)) { console.log('  ⚠ File not found:', MASTER_SHEET); return; }

  const wb = XLSX.readFile(MASTER_SHEET);
  const CORE_FIELDS = new Set([
    'email','first_name','last_name','company','phone','job_title','department',
    'industry','city','state','company_url','linkedin_personal','linkedin_company',
    'source','lead_category','elv_result','elv_esp','campaign_name'
  ]);

  // Column name → standard field mapping
  const COL_MAP = {
    'correo electronico': 'email',
    'nombre': 'first_name', 'apellido': 'last_name',
    'empresa': 'company', 'telefono': 'phone',
    'puesto': 'job_title', 'departamento': 'department',
    'industria': 'industry', 'municipio': 'city',
    'url compañía': 'company_url', 'url compania': 'company_url',
    'linkedin personal': 'linkedin_personal', 'linkedin empresa': 'linkedin_company',
    'fuente': 'source', 'lead category': 'lead_category',
    'elv result': 'elv_result', 'elv esp': 'elv_esp',
    'campaña': 'campaign_name', 'campana': 'campaign_name',
  };

  let totalRows = 0;

  for (const sheetName of wb.SheetNames) {
    console.log(`  Sheet: ${sheetName}`);
    const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
    if (!rawRows.length) continue;

    // Map column names; handle duplicate "Estado" (first=state, second=pipeline_status)
    const headers = Object.keys(rawRows[0]);
    const estadoIndices = headers.reduce((acc, h, i) => {
      if (h.toLowerCase() === 'estado') acc.push(i); return acc;
    }, []);

    const mappedRows = rawRows.map(rawRow => {
      const entries = Object.entries(rawRow);
      const row = {};
      const custom = {};
      let estadoCount = 0;

      entries.forEach(([k, v]) => {
        const norm = k.toLowerCase().trim();
        let field = COL_MAP[norm];

        if (norm === 'estado') {
          estadoCount++;
          field = estadoCount === 1 ? 'state' : null;
          if (estadoCount === 2) { custom['pipeline_status'] = toNull(v); return; }
        }

        if (field) {
          row[field] = toNull(v);
        } else if (!CORE_FIELDS.has(norm)) {
          custom[k] = toNull(v);
        }
      });

      row.custom = custom;
      return row;
    }).filter(r => r.email);

    await runBatch(async (row) => {
      await pool.query(`
        INSERT INTO contacts (
          email, first_name, last_name, company, phone, job_title, department,
          industry, city, state, company_url, linkedin_personal, linkedin_company,
          source, lead_category, elv_result, elv_esp, custom_fields
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
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
        row.email, row.first_name, row.last_name, row.company, row.phone,
        row.job_title, row.department, row.industry, row.city, row.state,
        row.company_url, row.linkedin_personal, row.linkedin_company,
        row.source, row.lead_category, row.elv_result, row.elv_esp,
        JSON.stringify(row.custom || {})
      ]);
    }, mappedRows);

    totalRows += mappedRows.length;
  }
  console.log(`  Total: ${totalRows} rows processed`);
}

// ── 2. Lead List → campaign_leads ─────────────────────────
async function importLeadList() {
  console.log('\n📋 Importing Campaign Lead List...');
  if (!fs.existsSync(LEAD_LIST)) { console.log('  ⚠ File not found:', LEAD_LIST); return; }

  const raw = parseCSV(fs.readFileSync(LEAD_LIST, 'utf8'));

  const CUSTOM_COLS = new Set(['Subject_1','Subject_2','Cold_Email_1','Cold_Email_2','job','industry','Job']);

  const rows = raw.map(r => ({
    email:            toNull(r['Email']),
    first_name:       toNull(r['First Name']),
    last_name:        toNull(r['Last Name']),
    company:          toNull(r['Company Name']),
    phone:            toNull(r['Phone Number']),
    job_title:        toNull(r['Job_Title']),
    department:       toNull(r['Department']),
    industry:         toNull(r['Industry']),
    city:             toNull(r['City']),
    country:          toNull(r['Country']),
    company_url:      toNull(r['Company_URL']),
    linkedin_personal: toNull(r['LinkedIn Profile']),
    campaign_name:    toNull(r['Campaña']),
    lead_category:    toNull(r['Category']),
    status:           toNull(r['Status']),
    esp_type:         toNull(r['ESP Type']),
    current_sequence: toNull(r['Current Sequence Number']),
    location:         toNull(r['Location']),
    company_city:     toNull(r['Company_City']),
    website:          toNull(r['Website']),
    custom: {
      subject_1:    toNull(r['Subject_1']),
      subject_2:    toNull(r['Subject_2']),
      cold_email_1: toNull(r['Cold_Email_1']),
      cold_email_2: toNull(r['Cold_Email_2']),
    }
  })).filter(r => r.email && r.campaign_name);

  await runBatch(async (row) => {
    // Ensure contact exists
    await pool.query(`
      INSERT INTO contacts (email, first_name, last_name, company, phone, job_title, department, industry, city, country, company_url, linkedin_personal)
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
        updated_at  = NOW()
    `, [row.email, row.first_name, row.last_name, row.company, row.phone,
        row.job_title, row.department, row.industry, row.city, row.country,
        row.company_url, row.linkedin_personal]);

    await pool.query(`
      INSERT INTO campaign_leads
        (email, campaign_name, lead_category, status, esp_type, current_sequence, location, company_city, website, custom_fields)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
    `, [row.email, row.campaign_name, row.lead_category, row.status, row.esp_type,
        row.current_sequence, row.location, row.company_city, row.website,
        JSON.stringify(row.custom)]);
  }, rows);
}

// ── 3. Report → campaign_activity ─────────────────────────
async function importReport() {
  console.log('\n📋 Importing Campaign Activity Report...');
  if (!fs.existsSync(REPORT)) { console.log('  ⚠ File not found:', REPORT); return; }

  const raw = parseCSV(fs.readFileSync(REPORT, 'utf8'));

  const rows = raw.map(r => ({
    email:           toNull(r['Lead Email']),
    campaign_name:   toNull(r['Campaña']),
    lead_name:       toNull(r['Lead Name']),
    sequence_number: toNull(r['Sequence Number']),
    sent_at:         parseDate(r['Sent Time']),
    opened_at:       parseDate(r['Opened Time']),
    clicked_at:      parseDate(r['Clicked Time']),
    replied_at:      parseDate(r['Replied Time']),
    reply_message:   toNull(r['Reply Message']),
    open_count:      parseInt(r['Open Count']) || 0,
    click_count:     parseInt(r['Click Count']) || 0,
    sent_email_body: toNull(r['Sent Email']),
    is_unsubscribed: parseBool(r['Is Unsubscribed']),
  })).filter(r => r.email && r.campaign_name && r.sequence_number);

  await runBatch(async (row) => {
    // Ensure contact exists
    await pool.query(
      `INSERT INTO contacts (email, first_name) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING`,
      [row.email, row.lead_name]
    );

    await pool.query(`
      INSERT INTO campaign_activity
        (email, campaign_name, lead_name, sequence_number, sent_at, opened_at,
         clicked_at, replied_at, reply_message, open_count, click_count, sent_email_body, is_unsubscribed)
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
    `, [row.email, row.campaign_name, row.lead_name, row.sequence_number,
        row.sent_at, row.opened_at, row.clicked_at, row.replied_at,
        row.reply_message, row.open_count, row.click_count,
        row.sent_email_body, row.is_unsubscribed]);
  }, rows);
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  console.log('🚀 CRM Labora - Initial Data Import');
  console.log('====================================');
  try {
    await importMasterSheet();
    await importLeadList();
    await importReport();
    console.log('\n✅ Import complete!');
  } catch (e) {
    console.error('\n❌ Fatal error:', e.message);
  } finally {
    await pool.end();
  }
}

main();
