require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Base de datos ──────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

// ── Middleware ─────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

// Middleware de autenticación para rutas de API (no para webhook)
function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ── Helper: limpiar HTML ──────────────────────────────────
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ═══════════════════════════════════════════════════════════
// WEBHOOK DE SMARTLEAD (recibe eventos desde n8n)
// ═══════════════════════════════════════════════════════════
app.post('/webhook/smartlead', async (req, res) => {
  const payload = req.body;
  const eventType = payload.event_type;

  try {
    // Determinar el email del contacto según el tipo de evento
    const email = payload.lead_email || payload.to_email;
    if (!email) return res.json({ ok: true, msg: 'Sin email, ignorado' });

    // Eventos que ignoramos
    const ignorados = ['CAMPAIGN_STATUS_CHANGED', 'UNTRACKED_REPLIES', 'MANUAL_STEP_REACHED', 'EMAIL_LINK_CLICK'];
    if (ignorados.includes(eventType)) return res.json({ ok: true, msg: 'Evento ignorado' });

    // ── 1. Upsert del contacto ──────────────────────────────
    const leadData = payload.lead_data || {};
    await pool.query(`
      INSERT INTO contactos (email, nombre, apellido, empresa, telefono, linkedin, ubicacion)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (email) DO UPDATE SET
        nombre    = COALESCE(EXCLUDED.nombre, contactos.nombre),
        apellido  = COALESCE(EXCLUDED.apellido, contactos.apellido),
        empresa   = COALESCE(EXCLUDED.empresa, contactos.empresa),
        telefono  = COALESCE(EXCLUDED.telefono, contactos.telefono),
        linkedin  = COALESCE(EXCLUDED.linkedin, contactos.linkedin),
        ubicacion = COALESCE(EXCLUDED.ubicacion, contactos.ubicacion),
        updated_at = NOW()
    `, [
      email,
      payload.lead_name || leadData.first_name || payload.to_name || null,
      leadData.last_name || null,
      leadData.company_name || null,
      leadData.phone_number || null,
      leadData.linkedin_profile || null,
      leadData.location || null
    ]);

    // ── 2. Procesar según event_type ───────────────────────
    switch (eventType) {

      case 'LEAD_CATEGORY_UPDATED': {
        const categoria = payload.category || payload.lead_category?.new_name || null;
        const sentiment = leadData.category?.sentiment_type || null;
        const ultimoReply = payload.last_reply || payload.lastReply || {};
        const mensaje = stripHtml(ultimoReply.email_body || '');
        const fechaResp = ultimoReply.time || payload.event_timestamp || null;

        await pool.query(`
          INSERT INTO interacciones
            (contacto_email, campaign_id, campaign_name, categoria, sentiment, mensaje_respuesta, historial, fecha_respuesta)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (contacto_email, campaign_id) DO UPDATE SET
            categoria         = EXCLUDED.categoria,
            sentiment         = EXCLUDED.sentiment,
            mensaje_respuesta = EXCLUDED.mensaje_respuesta,
            historial         = EXCLUDED.historial,
            fecha_respuesta   = EXCLUDED.fecha_respuesta,
            updated_at        = NOW()
        `, [
          email,
          payload.campaign_id || null,
          payload.campaign_name || null,
          categoria,
          sentiment,
          mensaje,
          JSON.stringify(payload.history || []),
          fechaResp
        ]);
        break;
      }

      case 'EMAIL_REPLY': {
        const replyMsg = payload.reply_message || {};
        const mensaje = stripHtml(replyMsg.html || payload.reply_body || '');
        const fecha = payload.time_replied || payload.event_timestamp || null;

        await pool.query(`
          INSERT INTO interacciones
            (contacto_email, campaign_id, campaign_name, categoria, mensaje_respuesta, fecha_respuesta)
          VALUES ($1, $2, $3, 'Respondió', $4, $5)
          ON CONFLICT (contacto_email, campaign_id) DO UPDATE SET
            mensaje_respuesta = CASE
              WHEN interacciones.categoria = 'Interested' THEN interacciones.mensaje_respuesta
              ELSE EXCLUDED.mensaje_respuesta
            END,
            fecha_respuesta = EXCLUDED.fecha_respuesta,
            updated_at = NOW()
        `, [email, payload.campaign_id || null, payload.campaign_name || null, mensaje, fecha]);
        break;
      }

      case 'EMAIL_BOUNCE': {
        await pool.query(`UPDATE contactos SET email_rebotado = TRUE, updated_at = NOW() WHERE email = $1`, [email]);
        break;
      }

      case 'LEAD_UNSUBSCRIBED': {
        await pool.query(`UPDATE contactos SET no_contactar = TRUE, updated_at = NOW() WHERE email = $1`, [email]);
        break;
      }

      case 'EMAIL_SENT': {
        // Registrar la campaña si no existe aún para este contacto
        await pool.query(`
          INSERT INTO interacciones (contacto_email, campaign_id, campaign_name, categoria)
          VALUES ($1, $2, $3, 'Enviado')
          ON CONFLICT (contacto_email, campaign_id) DO NOTHING
        `, [email, payload.campaign_id || null, payload.campaign_name || null]);
        break;
      }

      case 'EMAIL_OPEN': {
        await pool.query(`
          INSERT INTO interacciones (contacto_email, campaign_id, campaign_name, categoria)
          VALUES ($1, $2, $3, 'Abrió')
          ON CONFLICT (contacto_email, campaign_id) DO UPDATE SET
            categoria = CASE
              WHEN interacciones.categoria IN ('Interested', 'Respondió') THEN interacciones.categoria
              ELSE 'Abrió'
            END,
            updated_at = NOW()
        `, [email, payload.campaign_id || null, payload.campaign_name || null]);
        break;
      }
    }

    res.json({ ok: true, event: eventType, email });

  } catch (err) {
    console.error('Error en webhook:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// API REST — CONTACTOS
// ═══════════════════════════════════════════════════════════

// GET /api/contactos — lista con filtros
app.get('/api/contactos', authMiddleware, async (req, res) => {
  try {
    const { buscar, campaign, categoria, no_contactar, rebotado, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];
    let p = 1;

    if (buscar) {
      conditions.push(`(c.email ILIKE $${p} OR c.nombre ILIKE $${p} OR c.empresa ILIKE $${p})`);
      params.push(`%${buscar}%`); p++;
    }
    if (campaign) {
      conditions.push(`EXISTS (SELECT 1 FROM interacciones i WHERE i.contacto_email = c.email AND i.campaign_name ILIKE $${p})`);
      params.push(`%${campaign}%`); p++;
    }
    if (categoria) {
      conditions.push(`EXISTS (SELECT 1 FROM interacciones i WHERE i.contacto_email = c.email AND i.categoria = $${p})`);
      params.push(categoria); p++;
    }
    if (no_contactar === 'true') {
      conditions.push(`c.no_contactar = TRUE`);
    }
    if (rebotado === 'true') {
      conditions.push(`c.email_rebotado = TRUE`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM contactos c ${where}`, params
    );
    const total = parseInt(totalRes.rows[0].count);

    const rows = await pool.query(`
      SELECT
        c.*,
        (SELECT COUNT(*) FROM interacciones i WHERE i.contacto_email = c.email) AS total_campanas,
        (SELECT STRING_AGG(DISTINCT i.categoria, ', ')
         FROM interacciones i WHERE i.contacto_email = c.email) AS categorias,
        (SELECT STRING_AGG(DISTINCT i.campaign_name, ' | ')
         FROM interacciones i WHERE i.contacto_email = c.email) AS campanas,
        (SELECT MAX(i.fecha_respuesta)
         FROM interacciones i WHERE i.contacto_email = c.email) AS ultima_actividad
      FROM contactos c
      ${where}
      ORDER BY ultima_actividad DESC NULLS LAST, c.created_at DESC
      LIMIT $${p} OFFSET $${p+1}
    `, [...params, limit, offset]);

    res.json({ total, page: parseInt(page), limit: parseInt(limit), data: rows.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contactos/:email — detalle de un contacto
app.get('/api/contactos/:email', authMiddleware, async (req, res) => {
  try {
    const { email } = req.params;

    const contacto = await pool.query(`SELECT * FROM contactos WHERE email = $1`, [email]);
    if (!contacto.rows.length) return res.status(404).json({ error: 'Contacto no encontrado' });

    const interacciones = await pool.query(`
      SELECT * FROM interacciones WHERE contacto_email = $1 ORDER BY fecha_respuesta DESC NULLS LAST
    `, [email]);

    const notas = await pool.query(`
      SELECT * FROM notas WHERE contacto_email = $1 ORDER BY created_at DESC
    `, [email]);

    res.json({
      contacto: contacto.rows[0],
      interacciones: interacciones.rows,
      notas: notas.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notas — agregar nota a un contacto
app.post('/api/notas', authMiddleware, async (req, res) => {
  try {
    const { email, nota } = req.body;
    if (!email || !nota) return res.status(400).json({ error: 'email y nota son requeridos' });

    const result = await pool.query(`
      INSERT INTO notas (contacto_email, nota) VALUES ($1, $2) RETURNING *
    `, [email, nota]);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/notas/:id — eliminar nota
app.delete('/api/notas/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query(`DELETE FROM notas WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campanas — lista de campañas únicas
app.get('/api/campanas', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT campaign_name, campaign_id,
        COUNT(*) as total_contactos,
        COUNT(*) FILTER (WHERE categoria = 'Interested') as interesados
      FROM interacciones
      WHERE campaign_name IS NOT NULL
      GROUP BY campaign_name, campaign_id
      ORDER BY campaign_name
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — estadísticas generales
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM contactos) as total_contactos,
        (SELECT COUNT(DISTINCT contacto_email) FROM interacciones WHERE categoria = 'Interested') as total_interesados,
        (SELECT COUNT(*) FROM contactos WHERE no_contactar = TRUE) as no_contactar,
        (SELECT COUNT(*) FROM contactos WHERE email_rebotado = TRUE) as rebotados,
        (SELECT COUNT(DISTINCT campaign_name) FROM interacciones WHERE campaign_name IS NOT NULL) as total_campanas
    `);
    res.json(stats.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/exportar — exportar CSV con filtros
app.get('/api/exportar', authMiddleware, async (req, res) => {
  try {
    const { campaign, categoria } = req.query;
    const params = [];
    const conditions = [];
    let p = 1;

    if (campaign) {
      conditions.push(`i.campaign_name ILIKE $${p}`);
      params.push(`%${campaign}%`); p++;
    }
    if (categoria) {
      conditions.push(`i.categoria = $${p}`);
      params.push(categoria); p++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(`
      SELECT DISTINCT
        c.email,
        c.nombre,
        c.apellido,
        c.empresa,
        c.telefono,
        i.campaign_name as campana,
        i.categoria,
        i.fecha_respuesta
      FROM contactos c
      JOIN interacciones i ON i.contacto_email = c.email
      ${where}
      ORDER BY i.fecha_respuesta DESC NULLS LAST
    `, params);

    // Generar CSV manualmente
    const headers = ['email', 'nombre', 'apellido', 'empresa', 'telefono', 'campana', 'categoria', 'fecha_respuesta'];
    const csvRows = [headers.join(',')];

    for (const row of result.rows) {
      const values = headers.map(h => {
        const val = row[h] || '';
        return `"${String(val).replace(/"/g, '""')}"`;
      });
      csvRows.push(values.join(','));
    }

    const csv = csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads_interesados.csv"');
    res.send('\uFEFF' + csv); // BOM para Excel en español
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ruta catch-all para el frontend ───────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ── Iniciar servidor ───────────────────────────────────────
app.listen(PORT, () => {
  console.log(`CRM Labora corriendo en puerto ${PORT}`);
});
