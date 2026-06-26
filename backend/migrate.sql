-- ============================================================
-- CRM Labora - Migración de tablas españolas → inglesas (v2)
-- Ejecutar SOLO si ya tienes datos en las tablas viejas
-- ============================================================

-- 1. Crear tablas nuevas si no existen
\i schema.sql

-- 2. Migrar contactos → contacts
INSERT INTO contacts (
  email, first_name, last_name, company, phone,
  linkedin_personal, no_contact, email_bounced,
  created_at, updated_at
)
SELECT
  email, nombre, apellido, empresa, telefono,
  linkedin, no_contactar, email_rebotado,
  created_at, updated_at
FROM contactos
ON CONFLICT (email) DO NOTHING;

-- 3. Migrar interacciones → campaign_leads
INSERT INTO campaign_leads (
  email, campaign_name, campaign_id, lead_category,
  sentiment, reply_message, history, replied_at,
  created_at, updated_at
)
SELECT
  contacto_email, campaign_name, campaign_id, categoria,
  sentiment, mensaje_respuesta, historial, fecha_respuesta,
  created_at, updated_at
FROM interacciones
ON CONFLICT (email, campaign_name) DO NOTHING;

-- 4. Migrar notas → notes
INSERT INTO notes (email, note, created_at)
SELECT contacto_email, nota, created_at
FROM notas
ON CONFLICT DO NOTHING;
