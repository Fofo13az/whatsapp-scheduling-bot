# CLAUDE.md

Este archivo orienta a Claude Code cuando trabaja en este repositorio. Se lee al inicio de cada sesión.

---

## 🎯 Contexto del proyecto

**WhatsApp Scheduling Bot** es un sistema de gestión automatizada de citas médicas vía WhatsApp para un consultorio médico con dos sedes.

El bot:
- Conversa con pacientes en español mexicano natural
- Agenda citas en Apple Calendar vía CalDAV
- Envía recordatorios nocturnos automáticos
- Procesa confirmaciones, cancelaciones y reagendamientos
- Notifica a la doctora en su WhatsApp personal sobre eventos importantes

---

## 🚨 Reglas críticas (no negociables)

### Datos sensibles
- **Nunca** hardcodear teléfonos, API keys, secrets, o passwords en el código
- **Todo** va por variables de entorno (`process.env.*`)
- **Nunca** commitear `.env`, `bot.db`, archivos `.session`, o cualquier credencial
- Validar al startup que todas las env vars críticas estén presentes; fallar fast si falta alguna

### Ámbito de funcionalidad
- El bot **solo** agenda citas. **No** da consejos médicos, **no** procesa pagos, **no** manda mensajes masivos
- Si una paciente pregunta algo médico, el bot responde que mejor lo platique con la doctora en consulta
- **No** reemplaza el contacto humano — la doctora siempre tiene el control

### Calendario real
- **NO conectar al iCloud real de la doctora** hasta Fase 4
- En Fases 1-3, usar un calendario de prueba aparte (puede ser una cuenta de iCloud secundaria o calendario "Test" en la cuenta principal)
- Cualquier código que toque CalDAV debe poder configurarse para apuntar a calendarios distintos vía env var

### Número de producción
- **NO usar el número del consultorio real** hasta Fase 4
- Toda Fase 1-3 corre con el **número de test de la Cloud API de Meta** (gratis, hasta 5 destinatarios verificados, no requiere verificación de negocio)
- El cambio de número de test a producción se hace solo cambiando env vars (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`), sin tocar código

---

## 🛠️ Stack y herramientas

- **Runtime:** Node.js (versión LTS más reciente, especificar en `.nvmrc` cuando aplique)
- **Servidor HTTP:** Express
- **WhatsApp:** Meta WhatsApp Cloud API directo (Graph API vía `fetch` nativo, sin SDK ni BSP intermediario. Antes era Twilio; se migró en Sesión 4)
- **CalDAV:** `tsdav`
- **DB:** `MySQL` (Antes estaba pensado con SQLite, cambio de planes a MySQL)
- **Scheduler:** `node-cron`
- **Validación de schemas:** `zod` (para validar payloads de webhooks y env vars)
- **Logging:** `pino` (estructurado, JSON, fácil de leer en Railway)
- **Tests:** `vitest` (cuando lleguemos a Fase 4)

**Antes de instalar una nueva dependencia, justifícala.** Preferir librerías estándar y minimizar el árbol de dependencias.

---

## 📂 Convenciones de código

### Estilo

- **Lenguaje del código:** todo en inglés (variables, funciones, comentarios técnicos)
- **Mensajes al usuario:** todos en español mexicano natural, centralizados en `src/data/messages.js`
- **Logs:** en inglés, formato JSON estructurado
- **Commits:** en español, descriptivos, formato convencional

### Estructura de carpetas

Resumen:

```
src/
  config/         # Carga y validación de env vars
  webhook/        # Endpoint de la Cloud API de Meta (verificación + mensajes)
  handlers/       # Routers de mensajes
  flows/          # State machines (appointmentFlow, etc.)
  services/       # whatsappClient, CalDAV, classifier, repos
  scheduler/      # node-cron jobs
  data/           # Configuración estática (availability, types, messages)
  db/             # Schema, migraciones, conexión
```

### Naming

- **Archivos:** camelCase (`appointmentFlow.js`, `caldavService.js`)
- **Clases:** PascalCase (`AppointmentRepository`)
- **Funciones/variables:** camelCase
- **Constantes globales:** UPPER_SNAKE_CASE
- **Env vars:** UPPER_SNAKE_CASE con prefijos lógicos (`WHATSAPP_*`, `META_*`, `CALDAV_*`, `NOTIFY_*`)

### Patrón de error handling

- Errores esperados (validación de input, paciente no encontrada, etc.) → manejar con respuesta amigable a la paciente
- Errores inesperados (DB, red, CalDAV caído) → log estructurado + mensaje genérico a la paciente ("Hubo un problema, inténtalo en un momento") + alerta a la doctora
- **Nunca** exponer stack traces o detalles técnicos a las pacientes

### Comentarios

- Solo cuando agregan valor (el "por qué", no el "qué")
- En español si explican lógica de negocio, en inglés si son técnicos
- JSDoc en funciones públicas de servicios

---

## 🔄 Flujo de trabajo

### Antes de empezar cualquier tarea

1. Confirmar en qué fase estamos y qué corresponde
2. Revisar el último commit y el estado actual del repo
3. **Confirmar con el desarrollador antes de avanzar a la siguiente fase del plan**

### Durante el desarrollo

- Trabajar fase por fase, no saltar
- Después de cada cambio significativo: commit con mensaje descriptivo en español
- Mensajes de commit: imperativo presente ("Agrega X", "Corrige Y", "Refactoriza Z")
- Branches: trabajar en `main` por ahora; cuando crezca el equipo o tengamos producción, evaluar git-flow
- **Probar antes de marcar completado.** No asumir que algo funciona sin verificarlo

### Comunicación con el desarrollador

- **Idioma de la conversación:** español
- **Tono:** directo, técnico cuando se requiere, sin sobre-explicar lo obvio
- **Confirmaciones explícitas** antes de:
  - Cambiar de fase del plan
  - Instalar una dependencia nueva
  - Hacer cambios estructurales en arquitectura
  - Tocar credenciales o configuración de servicios externos
- **No** confirmar para cosas triviales (ej. naming interno, refactors menores, fixes claros)

---

## 🧪 Convenciones de testing

(Aplica desde Fase 4 en adelante)

- Tests unitarios para lógica de negocio (state machines, classifiers, services)
- Tests de integración para flujos end-to-end con DB en memoria y la Cloud API mockeada
- Coverage mínimo: 70% en services, 80% en flows
- Los tests viven en `tests/` espejando estructura de `src/`

---

## 📋 Estado de fases

- [x] **Fase 0:** Setup (Meta Cloud API, Railway, MySQL, calendarios)
- [x] **Fase 1:** Esqueleto y flujo conversacional con el número de test de la Cloud API
- [x] **Fase 2:** Integración de calendarios (CalDAV/iCloud y Google Calendar)
- [x] **Fase 3:** Notificaciones, recordatorios, reagendamiento y templates de Meta
- [x] **Fase 4:** Pruebas con número y calendarios reales
- [x] **Fase 5:** Lanzamiento en producción (ago 2026) y lista de espera

Mantener este checklist actualizado conforme avance el proyecto.

---

## 🔗 Referencias rápidas

- **WhatsApp Cloud API (Meta):** https://developers.facebook.com/docs/whatsapp/cloud-api
- **Referencia de mensajes:** https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
- **Webhooks de la Cloud API:** https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
- **Documentación tsdav:** https://github.com/natelindev/tsdav
- **CalDAV iCloud:** servidor `https://caldav.icloud.com`
- **Railway docs:** https://docs.railway.app

---

## 💡 Filosofía del proyecto

> **Hacer una cosa bien, en lugar de varias cosas a medias.**

El bot tiene un alcance acotado a propósito: gestión de citas. Cada feature nuevo se evalúa contra la pregunta: *"¿Esto mejora la experiencia de agendar citas, o estamos expandiendo el alcance?"*

**Calidad sobre velocidad.** Es un sistema que va a manejar pacientes reales. Mejor arrancar tarde con algo robusto que rápido con algo frágil.

**Privacidad por diseño.** Los datos de pacientes se tratan como datos médicos sensibles, aunque legalmente sean solo de contacto y agenda.
