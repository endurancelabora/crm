-- ============================================================
-- CRM Labora - Schema PostgreSQL (English, v2)
-- ============================================================

CREATE TABLE IF NOT EXISTS contacts (
  id              SERIAL PRIMARY KEY,
  email           VARCHAR(255) UNIQUE NOT NULL,
  first_name      VARCHAR(255),
  last_name       VARCHAR(255),
  company         VARCHAR(255),
  phone           VARCHAR(100),
  job_title       VARCHAR(255),
  department      VARCHAR(255),
  industry        VARCHAR(255),
  city            VARCHAR(255),
  state           VARCHAR(255),
  country         VARCHAR(100),
  company_url     VARCHAR(500),
  linkedin_personal VARCHAR(500),
  linkedin_company  VARCHAR(500),
  source          VARCHAR(255),
  lead_category   VARCHAR(100),
  elv_result      VARCHAR(100),
  elv_esp         VARCHAR(100),
  no_contact      BOOLEAN DEFAULT FALSE,
  email_bounced   BOOLEAN DEFAULT FALSE,
  custom_fields   JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- One row per contact+campaign (from Lead List / webhook)
CREATE TABLE IF NOT EXISTS campaign_leads (
  id               SERIAL PRIMARY KEY,
  email            VARCHAR(255) NOT NULL REFERENCES contacts(email) ON UPDATE CASCADE ON DELETE CASCADE,
  campaign_name    VARCHAR(500),
  campaign_id      INTEGER,
  lead_category    VARCHAR(100),
  status           VARCHAR(100),
  esp_type         VARCHAR(100),
  current_sequence VARCHAR(100),
  location         VARCHAR(255),
  company_city     VARCHAR(255),
  website          VARCHAR(500),
  sentiment        VARCHAR(50),
  reply_message    TEXT,
  history          JSONB,
  replied_at       TIMESTAMPTZ,
  custom_fields    JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(email, campaign_name)
);

-- One row per contact+campaign+sequence (from Report)
CREATE TABLE IF NOT EXISTS campaign_activity (
  id              SERIAL PRIMARY KEY,
  email           VARCHAR(255) NOT NULL REFERENCES contacts(email) ON UPDATE CASCADE ON DELETE CASCADE,
  campaign_name   VARCHAR(500),
  lead_name       VARCHAR(255),
  sequence_number VARCHAR(50),
  sent_at         TIMESTAMPTZ,
  opened_at       TIMESTAMPTZ,
  clicked_at      TIMESTAMPTZ,
  replied_at      TIMESTAMPTZ,
  reply_message   TEXT,
  open_count      INTEGER DEFAULT 0,
  click_count     INTEGER DEFAULT 0,
  sent_email_body TEXT,
  is_unsubscribed BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(email, campaign_name, sequence_number)
);

CREATE TABLE IF NOT EXISTS notes (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL REFERENCES contacts(email) ON UPDATE CASCADE ON DELETE CASCADE,
  note       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_contacts_email         ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_company       ON contacts(company);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_email   ON campaign_leads(email);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_name    ON campaign_leads(campaign_name);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_cat     ON campaign_leads(lead_category);
CREATE INDEX IF NOT EXISTS idx_campaign_activity_email ON campaign_activity(email);
CREATE INDEX IF NOT EXISTS idx_campaign_activity_name  ON campaign_activity(campaign_name);
CREATE INDEX IF NOT EXISTS idx_notes_email            ON notes(email);

-- Auto updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contacts_updated ON contacts;
CREATE TRIGGER trg_contacts_updated
  BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_campaign_leads_updated ON campaign_leads;
CREATE TRIGGER trg_campaign_leads_updated
  BEFORE UPDATE ON campaign_leads FOR EACH ROW EXECUTE FUNCTION update_updated_at();
