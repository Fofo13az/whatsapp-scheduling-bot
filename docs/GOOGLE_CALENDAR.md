# Google Calendar para el consultorio de Sur — guía de setup

> **Por qué existe esto (E2E 21/08/2026):** el calendario de Sur vive en
> la cuenta de **Google** de la doctora — está compartido con su secretaria,
> que agenda desde Android — y solo se *muestra* en su Apple Calendar. El
> CalDAV de iCloud no puede verlo. El bot ahora rutea cada consultorio a su
> proveedor: **Norte → iCloud (CalDAV)**, **Sur → Google Calendar**.
>
> La integración usa una **service account** de Google Cloud: un "usuario
> robot" con su propio email. La doctora comparte su calendario con ese email
> (como lo haría con una persona) y el bot opera con la llave de la service
> account. Sin OAuth de usuario, sin pantallas de consentimiento, sin tokens
> que expiran, y sin pasar por verificación de app de Google.

## Paso 1 — Proyecto en Google Cloud (~5 min)

1. https://console.cloud.google.com → crear proyecto (ej. `whatsapp-scheduling-bot`).
2. **APIs & Services → Library** → buscar **Google Calendar API** → **Enable**.
3. **APIs & Services → Credentials → Create Credentials → Service account**.
   - Nombre: ej. `scheduler-bot` → Create. Sin roles (no los necesita). Done.
4. Entrar a la service account → pestaña **Keys** → **Add key → Create new
   key → JSON** → se descarga un archivo `.json`. **Trátalo como password:
   no lo commitees ni lo compartas.**

Del JSON se usan dos campos:

| Campo del JSON | Env var |
|---|---|
| `client_email` | `GOOGLE_SA_EMAIL` |
| `private_key` | `GOOGLE_SA_PRIVATE_KEY` |

> **Formato de la llave en `.env`/Railway:** el `private_key` del JSON ya
> viene en una línea con `\n` literales — se pega TAL CUAL (con comillas no;
> con los `\n` sí). El bot los convierte a saltos reales.

## Paso 2 — La doctora comparte el calendario (~2 min, desde su Google Calendar)

En https://calendar.google.com (su cuenta de Gmail):

1. Configuración del calendario de Sur ("Calendario sur") →
   **Compartir con determinadas personas** → **Añadir personas**.
2. Pegar el email de la service account (`GOOGLE_SA_EMAIL`, termina en
   `...iam.gserviceaccount.com`).
3. Permiso: **"Hacer cambios en eventos"** (necesario para crear/borrar citas).
4. En la misma pantalla, copiar el **ID del calendario** (sección "Integrar el
   calendario"). Si es un calendario secundario se ve como
   `xxxx@group.calendar.google.com`; si fuera el principal, es su gmail.

## Paso 3 — Env vars (local y Railway)

```bash
GOOGLE_SA_EMAIL=scheduler-bot@your-project.iam.gserviceaccount.com
GOOGLE_SA_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n
GOOGLE_CALENDAR_SUR=xxxx@group.calendar.google.com
```

- Con `GOOGLE_CALENDAR_SUR` definido, `CALDAV_CALENDAR_SUR` se
  ignora (puede borrarse).
- Norte no se toca: sigue por CalDAV/iCloud.
- Config inválida falla fast al boot: `GOOGLE_CALENDAR_*` sin `GOOGLE_SA_*`
  detiene el arranque con mensaje claro.

## Paso 4 — Verificar

Al arrancar, el log debe decir `Calendarios conectados` listando ambos:

```
calendars: { norte: "Calendario norte", sur: "Calendario sur" }
```

Si Google aparece con error "calendarios inaccesibles (¿compartidos con ...?)"
→ falta el Paso 2 o el ID del calendario está mal.

## Semántica (idéntica a la de iCloud)

- La disponibilidad lee **ambos** proveedores fusionados (bloqueo global).
- Eventos de día completo bloquean el día en hora del consultorio.
- Eventos marcados **"Disponible"** (Mostrar como → Disponible) NO bloquean —
  sirve para recordatorios que no deben comerse horarios. Cancelados tampoco.
- Lo que agende la secretaria bloquea horarios del bot, y las citas del bot
  le aparecen a ella — el calendario compartido sigue siendo la fuente común.
- Un proveedor caído no tumba al otro: si Google no responde, los bloqueos de
  iCloud siguen aplicando (y viceversa), con error en logs.
