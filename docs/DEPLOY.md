# DEPLOY.md — Guía de deployment en Railway

Paso a paso para llevar el bot de local a producción en Railway. Escrita para
ejecutarse en orden; cada sección dice qué verificar antes de seguir.

**Contexto del proyecto en Railway:** ya existe un proyecto con el repo
conectado, pero el primer deploy falló. Con el `Dockerfile` + `railway.json`
de la Sesión 10 el build es determinista; las causas típicas del fallo previo
eran (a) env vars faltantes → `src/config/index.js` hace `process.exit(1)` al
arranque, y (b) sin MySQL → `connectDb()` truena. Ambas se resuelven abajo.

---

## 1. Servicio MySQL

1. En el proyecto de Railway: **+ New → Database → Add MySQL**.
2. Railway crea el servicio con sus propias variables (`MYSQLHOST`,
   `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQLDATABASE` y las públicas
   `MYSQL_PUBLIC_URL`...). **Ojo: los nombres NO coinciden con los nuestros**
   (los nuestros llevan guion bajo: `MYSQL_HOST`).
3. En el servicio **del bot** → pestaña **Variables**, crear las nuestras
   referenciando las del servicio MySQL (autocompleta al escribir `${{`):

   | Variable del bot | Valor (referencia) |
   |---|---|
   | `MYSQL_HOST` | `${{MySQL.MYSQLHOST}}` |
   | `MYSQL_PORT` | `${{MySQL.MYSQLPORT}}` |
   | `MYSQL_USER` | `${{MySQL.MYSQLUSER}}` |
   | `MYSQL_PASSWORD` | `${{MySQL.MYSQLPASSWORD}}` |
   | `MYSQL_DATABASE` | `${{MySQL.MYSQLDATABASE}}` |

   (Si el servicio MySQL se llama distinto a "MySQL", ajustar el prefijo.)
   Las referencias usan la red **privada** de Railway — sin costo de egress.

## 2. Variables de entorno del bot

En el servicio del bot → **Variables**, además de las 5 de MySQL de arriba:

| Variable | Valor en producción | Notas |
|---|---|---|
| `NODE_ENV` | `production` | Activa logs JSON y arranque degradado si CalDAV falla |
| `TIMEZONE` | `America/Mexico_City` | |
| `LOG_LEVEL` | `info` | |
| `WHATSAPP_TOKEN` | token del System User | El permanente, NO el temporal de 24h |
| `WHATSAPP_PHONE_NUMBER_ID` | ID del número de TEST por ahora | El switch al número real es solo cambiar esta variable |
| `WHATSAPP_VERIFY_TOKEN` | el mismo string del `.env` local | Debe coincidir con el configurado en la consola de Meta |
| `META_APP_SECRET` | App → Settings → Basic | Valida la firma de los webhooks |
| `GRAPH_API_VERSION` | `v25.0` | |
| `DOCTOR_PERSONAL_PHONE` | `+52...` (E.164 con `+`) | |
| `DOCTOR_NAME` | `Dra. Ejemplo` (o como ella prefiera) | |
| `CALDAV_SERVER_URL` | `https://caldav.icloud.com` | |
| `CALDAV_USERNAME` | cuenta iCloud del desarrollador (por ahora) | Migrar a la de la doctora = cambiar estas 4 vars |
| `CALDAV_APP_SPECIFIC_PASSWORD` | app-specific password | |
| `CALDAV_CALENDAR_SUR` | nombre exacto del calendario | |
| `CALDAV_CALENDAR_NORTE` | nombre exacto del calendario | |
| `REMINDER_TIME` | `20:00` | |
| `REMINDER_FOLLOWUP_HOURS` | `2` | |
| `REMINDER_TEMPLATE_NAME` | *(vacío hasta que Meta apruebe)* | Luego: `appointment_reminder` |
| `DOCTOR_TEMPLATES_ENABLED` | `false` *(hasta que Meta apruebe)* | Luego: `true` |
| `NOTIFY_NEW_APPOINTMENT` | `true` | |
| `NOTIFY_CONFIRMATION` | `true` | |
| `NOTIFY_CANCELLATION` | `true` | |
| `NOTIFY_NO_RESPONSE` | `true` | |
| `NOTIFY_RESCHEDULE` | `true` | |

`PORT` **no se configura**: Railway la inyecta y el server la lee solo.

> Truco: el botón **Raw Editor** de la pestaña Variables acepta pegar bloques
> `KEY=value` completos, estilo `.env`.

## 3. Deploy

1. Con el `Dockerfile` y `railway.json` ya en `main`, Railway detecta el
   Dockerfile automáticamente y redeploya con cada push a `main`.
2. Si no arranca solo: **Deployments → Redeploy**.
3. El deploy queda "healthy" solo cuando `/health` responde 200
   (healthcheck configurado en `railway.json`).
4. **Ver logs:** servicio del bot → Deployments → View logs. Los errores de
   config listan exactamente qué variable falta.

**Nota:** el primer deploy va a FALLAR el healthcheck a propósito si la DB
está vacía — `connectDb()` detecta que faltan tablas y pide correr init-db.
Es el paso 4.

## 4. Inicializar el schema en la MySQL de Railway

Desde tu máquina, usando las credenciales **públicas** del servicio MySQL
(servicio MySQL → Variables → `MYSQL_PUBLIC_URL`, o los campos de "Connect"):

```bash
node scripts/init-db.js
```

con las env vars apuntando a Railway (PowerShell):

```powershell
$env:MYSQL_HOST='<host público, ej. viaduct.proxy.rlwy.net>'
$env:MYSQL_PORT='<puerto público>'
$env:MYSQL_USER='root'
$env:MYSQL_PASSWORD='<password>'
$env:MYSQL_DATABASE='railway'
node scripts/init-db.js
```

Debe terminar con `Schema aplicado — las 3 tablas existen`. Es idempotente:
correrlo dos veces no rompe nada. Después: **Redeploy** del bot → el
healthcheck debe pasar.

⚠️ Esas variables quedan en tu sesión de PowerShell — cierra la terminal
después, y no las pegues en ningún archivo del repo.

## 5. Apuntar el webhook de Meta a Railway

1. Copiar el dominio público del bot (servicio → Settings → Networking →
   **Generate Domain** si aún no existe): `https://<app>.up.railway.app`.
2. En [developers.facebook.com](https://developers.facebook.com) → tu App →
   **WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://<app>.up.railway.app/webhook/whatsapp`
   - Verify token: el valor de `WHATSAPP_VERIFY_TOKEN`
   - **Verify and save** (el server ya debe estar arriba — el GET de
     verificación pega contra Railway).
3. Campo `messages` suscrito (Manage → messages → Subscribe).
4. **El gotcha de la Sesión 4:** verificar que la App esté suscrita a la WABA:

   ```bash
   curl "https://graph.facebook.com/v25.0/<WABA_ID>/subscribed_apps" -H "Authorization: Bearer <WHATSAPP_TOKEN>"
   ```

   Si la app "WhatsApp Scheduling Bot" no aparece, suscribirla:

   ```bash
   curl -X POST "https://graph.facebook.com/v25.0/<WABA_ID>/subscribed_apps" -H "Authorization: Bearer <WHATSAPP_TOKEN>"
   ```

5. Al cambiar el webhook a Railway, ngrok deja de recibir eventos (el dev
   local ya no verá mensajes hasta regresar la URL — es normal).

## 6. Smoke E2E contra producción

1. `https://<app>.up.railway.app/health` en el navegador → `{"status":"ok",...}`.
2. Desde tu WhatsApp (número verificado del test): mandar "hola" → debe
   responder el saludo + menú de tipos.
3. Agendar una cita completa → verificar: fila en la MySQL de Railway
   (Data tab del servicio MySQL), evento en el calendario de iCloud,
   notificación a la doctora (tu número configurado).
4. Disparar el recordatorio a mano contra Railway no es necesario — el cron
   corre a las 20:00 CDMX; para probarlo antes, agenda una cita para mañana
   y espera la corrida, o corre `scripts/trigger-reminders.js` local
   apuntando el `.env` local a la MySQL de Railway (mismas 5 vars del paso 4).

## 7. Switch al número real del consultorio (cuando Meta apruebe los templates)

Solo variables, cero código:

1. `WHATSAPP_PHONE_NUMBER_ID` → el ID del número real (ya registrado en la
   Cloud API desde Fase 0).
2. `REMINDER_TEMPLATE_NAME=appointment_reminder`,
   `DOCTOR_TEMPLATES_ENABLED=true` y
   `WAITLIST_OFFER_TEMPLATE_NAME=waitlist_slot_offer` (templates aprobados).
3. Verificar `subscribed_apps` otra vez (paso 5.4) — al cambiar de número a
   veces hay que re-suscribir.
4. Probar el flujo completo con el número real antes de compartirlo con
   pacientes (lanzamiento gradual).

> ⚠️ **Los templates pertenecen a la WABA, no al número.** Si el número real
> vive en una cuenta de WhatsApp Business distinta a donde se crearon los
> templates (típico: se crearon en la "Test WhatsApp Business Account" de la
> app de desarrollo), los envíos fallan con
> `404 — (#132001) Template name does not exist in the translation`. No se
> pueden mover entre cuentas: hay que **recrearlos en la WABA real** (mismos
> nombres → no se toca ninguna env var). Pasó en la Sesión 13; verificar el
> selector de cuenta de WhatsApp Manager antes de crear el primero.

Para migrar el calendario al iCloud de la doctora (cuando dé su app-specific
password): cambiar `CALDAV_USERNAME`, `CALDAV_APP_SPECIFIC_PASSWORD`,
`CALDAV_CALENDAR_SUR`, `CALDAV_CALENDAR_NORTE`. Las citas creadas
antes del cambio viven en los calendarios viejos (borrarlas a mano si eran
de prueba).

---

## 8. Limpieza previa al lanzamiento

Antes de entregarle el bot a la doctora conviene dejarlo "en blanco": sin
pacientes ni citas de prueba. Dos lados:

**MySQL de Railway** (editor SQL de la pestaña Data del servicio MySQL, en
este orden — `waitlist` se vacía sola por la FK `ON DELETE CASCADE`):

```sql
DELETE FROM conversations;
DELETE FROM slot_offers;
DELETE FROM appointments;
DELETE FROM patients;
```

Verificación: `SELECT COUNT(*) FROM waitlist;` debe dar 0.

**Calendarios de la doctora:** borrar a mano los eventos de prueba que el bot
haya creado (se reconocen por el nombre de la paciente de prueba) — en el
calendario de Norte (iCloud/iPhone) y en el del Sur (Google Calendar).
Borrarlos directo del calendario es seguro: el bot recalcula la disponibilidad
en cada consulta y la DB ya quedó vacía.

---

## 9. Migraciones de schema (actualizaciones sobre una DB ya en uso)

`schema.sql` trae el schema **final** para DBs nuevas; las DBs que ya existen
reciben los cambios con los archivos de `src/db/migrations/`, **una sola vez**
cada uno. Todas las migraciones son aditivas (columnas `NULL`): se aplican
**ANTES** de pushear el código que las usa. El código viejo funciona igual
con ellas, y el nuevo falla al boot con un mensaje claro si falta alguna.

| Migración | Actualización |
|---|---|
| `2026-09-24_actualizacion.sql` | 23/09 — statuses de entrega, lista de espera en texto |

La revisión del 25/09 (lista de espera a voluntad) **no trae migración**: usa
las tablas y columnas que ya existen.

**Railway:** servicio MySQL → pestaña **Data** → editor SQL → pegar el
contenido del archivo y correr. Verificación:

```sql
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND column_name IN ('reminder_message_id', 'reminder_delivery_status',
                       'reminder_delivery_error', 'offer_message_id', 'doctor_browsed_at');
```

Debe devolver 5 filas.

**Local:** `node scripts/init-db.js --migration src/db/migrations/2026-09-24_actualizacion.sql`

---

## Diagnóstico rápido

| Síntoma | Causa probable | Fix |
|---|---|---|
| Deploy "crashed" al segundo | Env var faltante/incorrecta | Logs: el mensaje de Zod lista el campo exacto |
| Healthcheck failed, logs dicen "Faltan tablas" | DB vacía | Paso 4 (init-db) |
| Healthcheck failed, logs dicen "No se pudo conectar a MySQL" | Referencias `${{MySQL.*}}` mal escritas o servicio MySQL caído | Revisar paso 1 |
| Bot arriba pero no responde mensajes | Webhook aún apunta a ngrok, o WABA sin suscribir | Paso 5 |
| Responde pero no crea eventos de calendario | CalDAV mal configurado (en producción arranca degradado con error en logs) | Revisar vars `CALDAV_*` |
| `131030` al responder | El destinatario no está en la lista del número de test | Agregarlo en API Setup |
| `131047` en notificaciones a la doctora | Ventana de 24h cerrada y templates aún no aprobados/activados | Esperar aprobación → `DOCTOR_TEMPLATES_ENABLED=true` |
| Healthcheck failed, logs dicen "Faltan columnas" | Falta aplicar una migración | Paso 9 |
| Logs: `Meta NO entregó un mensaje saliente` | Meta aceptó el mensaje pero no lo entregó (status `failed`) | El log trae el código de error de Meta (p. ej. 131042: método de pago vencido) |
| Logs: `Freno de seguridad del sync con calendario` | Demasiadas citas "movidas/borradas" a la vez — casi siempre acceso/conexión al calendario | Revisar `CALDAV_*` / `GOOGLE_*` y que los calendarios sigan compartidos; el bot no cambió nada |
