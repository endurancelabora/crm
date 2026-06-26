# Guía de instalación — CRM Labora

## Lo que vas a necesitar
- Cuenta en GitHub (gratuita): https://github.com
- Cuenta en Railway (gratuita para empezar): https://railway.app
- Tu n8n cloud (ya lo tienes)

Tiempo estimado: 20-30 minutos

---

## PASO 1 — Subir el código a GitHub

1. Ve a https://github.com y crea una cuenta si no tienes
2. Haz clic en "New repository"
3. Nombre: `crm-labora`
4. Ponlo en **Private** (para que solo tú lo veas)
5. Haz clic en "Create repository"
6. En la siguiente pantalla, verás opciones para subir archivos
7. Arrastra toda la carpeta `crm-labora` a la ventana del navegador
8. Haz clic en "Commit changes"

---

## PASO 2 — Crear el proyecto en Railway

1. Ve a https://railway.app y crea cuenta (puedes entrar con GitHub)
2. Haz clic en "New Project"
3. Selecciona "Deploy from GitHub repo"
4. Elige el repositorio `crm-labora`
5. Railway detectará el proyecto automáticamente

---

## PASO 3 — Agregar la base de datos PostgreSQL

1. Dentro de tu proyecto en Railway, haz clic en "New Service"
2. Selecciona "Database" → "PostgreSQL"
3. Railway creará la base de datos automáticamente
4. Haz clic en la base de datos → pestaña "Connect"
5. Copia el valor de "DATABASE_URL" (algo como `postgresql://...`)

---

## PASO 4 — Configurar las variables de entorno

1. En Railway, haz clic en tu servicio (el código, no la base de datos)
2. Ve a la pestaña "Variables"
3. Agrega estas variables una por una:

```
DATABASE_URL    = (el valor que copiaste en el paso 3)
API_KEY         = (inventa una clave segura, ej: MiCRM2025$Labora)
SMARTLEAD_SECRET = (tu secret key de Smartlead — opcional por ahora)
PORT            = 3000
```

4. Haz clic en "Deploy" para aplicar los cambios

---

## PASO 5 — Crear las tablas en la base de datos

1. En Railway, haz clic en tu servicio PostgreSQL
2. Ve a la pestaña "Query"
3. Copia y pega todo el contenido del archivo `backend/schema.sql`
4. Haz clic en "Run Query"
5. Deberías ver "Query executed successfully"

---

## PASO 6 — Obtener la URL de tu CRM

1. En Railway, haz clic en tu servicio de código
2. Ve a "Settings" → "Networking"
3. Haz clic en "Generate Domain"
4. Te dará una URL tipo: `https://crm-labora-production.up.railway.app`
5. ¡Esa es la URL de tu CRM! Guárdala.

---

## PASO 7 — Configurar el webhook en n8n

1. Abre tu n8n cloud
2. Crea un nuevo workflow
3. Haz clic en "Import from JSON"
4. Pega el contenido del archivo `n8n/workflow.json`
5. En el nodo "Enviar a CRM", cambia la URL por:
   `https://TU-URL-DE-RAILWAY/webhook/smartlead`
6. Activa el workflow (toggle arriba a la derecha)
7. Copia la URL del webhook de n8n (la verás en el nodo "Webhook Smartlead")

---

## PASO 8 — Configurar el webhook en Smartlead

1. En Smartlead, ve a Settings → Webhooks
2. Haz clic en "Add Webhook"
3. En la URL, pega la URL de tu webhook de n8n
4. Selecciona los eventos que quieres capturar:
   - ✅ LEAD_CATEGORY_UPDATED (el más importante)
   - ✅ EMAIL_REPLY
   - ✅ EMAIL_BOUNCE
   - ✅ LEAD_UNSUBSCRIBED
   - ✅ EMAIL_SENT
   - ✅ EMAIL_OPEN
5. Guarda

---

## PASO 9 — Probar que todo funciona

1. Abre la URL de tu CRM en el navegador
2. Ingresa la API_KEY que configuraste en Railway
3. Deberías ver el CRM con las estadísticas en cero (normal, es nuevo)
4. Para probar, ve a Smartlead → cambia la categoría de un lead a "Interested"
5. En unos segundos debería aparecer en tu CRM

---

## Costo estimado

- GitHub: Gratis
- Railway (plan Hobby): $5 USD/mes
  - Incluye el servidor y la base de datos PostgreSQL
  - Más que suficiente para tu volumen

---

## Preguntas frecuentes

**¿Qué pasa con los leads que ya tengo en mis Sheets?**
Puedes importarlos manualmente. Avísame y te preparo un script
que lee tus Sheets actuales y los mete a la base de datos.

**¿Puedo acceder desde el celular?**
Sí, la URL de Railway funciona desde cualquier dispositivo.

**¿Puedo darle acceso a alguien más?**
Sí, simplemente comparte la URL y la API_KEY. En el futuro
podemos agregar múltiples usuarios con diferentes claves.

**¿Mis datos están seguros?**
Sí. El repositorio de GitHub es privado, la base de datos
solo es accesible desde Railway, y el CRM requiere API_KEY.
