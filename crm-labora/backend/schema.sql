-- ============================================================
-- CRM Labora - Schema PostgreSQL
-- ============================================================

-- Tabla de contactos (un registro por email único)
CREATE TABLE IF NOT EXISTS contactos (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  nombre VARCHAR(255),
  apellido VARCHAR(255),
  empresa VARCHAR(255),
  telefono VARCHAR(100),
  linkedin VARCHAR(500),
  ubicacion VARCHAR(255),
  no_contactar BOOLEAN DEFAULT FALSE,
  email_rebotado BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabla de interacciones por campaña
-- Un contacto puede tener múltiples interacciones (una por campaña)
CREATE TABLE IF NOT EXISTS interacciones (
  id SERIAL PRIMARY KEY,
  contacto_email VARCHAR(255) NOT NULL REFERENCES contactos(email) ON UPDATE CASCADE,
  campaign_id INTEGER,
  campaign_name VARCHAR(500),
  categoria VARCHAR(100),        -- Interested, Out of Office, Not Interested, etc.
  sentiment VARCHAR(50),         -- positive, negative, neutral
  mensaje_respuesta TEXT,        -- último mensaje recibido del lead
  historial JSONB,               -- historial completo de emails de Smartlead
  fecha_respuesta TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contacto_email, campaign_id)   -- un registro por campaña por contacto
);

-- Tabla de notas manuales
CREATE TABLE IF NOT EXISTS notas (
  id SERIAL PRIMARY KEY,
  contacto_email VARCHAR(255) NOT NULL REFERENCES contactos(email) ON UPDATE CASCADE,
  nota TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_contactos_email ON contactos(email);
CREATE INDEX IF NOT EXISTS idx_interacciones_email ON interacciones(contacto_email);
CREATE INDEX IF NOT EXISTS idx_interacciones_campaign ON interacciones(campaign_name);
CREATE INDEX IF NOT EXISTS idx_interacciones_categoria ON interacciones(categoria);
CREATE INDEX IF NOT EXISTS idx_notas_email ON notas(contacto_email);

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_contactos_updated
  BEFORE UPDATE ON contactos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_interacciones_updated
  BEFORE UPDATE ON interacciones
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
