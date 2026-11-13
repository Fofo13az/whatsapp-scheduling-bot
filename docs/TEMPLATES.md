# Templates de Meta — versión FINAL para someter

> **Estado: FINAL (Sesión 10).** Decisión: se someten tal cual, sin
> ronda extra con la doctora, para no atrasar el lanzamiento (la redacción de
> los mensajes conversacionales ya la revisó ella en Sesión 8; estos siguen el
> mismo tono). Someter HOY los 7 marcados como requeridos — la aprobación
> tarda 3-7 días y es el único bloqueador externo que queda.
>
> **A someter (9):** `appointment_reminder` + los 6 `doctor_*` + los 2 de la
> lista de espera (`doctor_waitlist_offer` y `waitlist_slot_offer`, agregados
> en la actualización del 19/08/2026 — ver templates 9 y 10 abajo).
> **No se somete:** `appointment_created` (opcional, caso edge — ver abajo).
>
> En desarrollo el bot NO usa estos templates: el recordatorio se manda como
> mensaje interactivo de sesión (funciona con el número de test dentro de la
> ventana de 24h). El switch a templates es pura configuración, sin tocar
> código, cuando Meta apruebe:
>
> - `REMINDER_TEMPLATE_NAME=appointment_reminder` → recordatorio nocturno
> - `DOCTOR_TEMPLATES_ENABLED=true` → notificaciones a la doctora con fallback
>   automático a template cuando su ventana de 24h esté cerrada (implementado
>   en `notificationService.js`, Sesión 10)
>
> **Actualización 23/09/2026:** hay **2 templates nuevos** a someter
> (`doctor_reminder_undelivered` y `doctor_calendar_removed`) — ver
> [`docs/TEMPLATES_23-09.md`](./TEMPLATES_23-09.md). No bloquean nada: mientras
> no se aprueben, esos avisos salen por `doctor_alert`.
>
> **Revisión 25/09/2026 (lista de espera a voluntad): sin templates nuevos.**
> Todo lo que ve la doctora responde a algo que ella acaba de escribir o tocar
> (ventana de 24h abierta), y la propuesta a la paciente reusa
> `waitlist_slot_offer` ("se liberó un espacio… te lo está ofreciendo" sigue
> siendo cierto para ella). Si la paciente rechaza, el aviso a la doctora sale
> por `doctor_waitlist_offer` como siempre.
>
> ⚠️ **Los nombres de los templates son contrato con el código.** Crear cada
> template en WhatsApp Manager EXACTAMENTE con el nombre indicado (el mapeo
> evento→template vive en `DOCTOR_TEMPLATE_BY_EVENT` de
> `src/services/notificationService.js`).

---

## Template 1: `appointment_reminder` (recordatorio nocturno) — REQUERIDO

El único template estrictamente necesario para Fase 3/4: el recordatorio lo
inicia el bot fuera de la ventana de 24h, así que Meta exige template aprobado.

| Campo | Valor |
|---|---|
| Nombre | `appointment_reminder` |
| Categoría | **Utility** (no Marketing — crítico para la aprobación) |
| Idioma | Spanish (MEX) — `es_MX` |
| Tipo | Texto + Quick Reply Buttons |

**Cuerpo (borrador):**

```
Hola {{1}} 👋, te recuerdo tu cita con la {{2}}:

📅 Mañana {{3}}
🕐 {{4}}
📍 {{5}}

¿Confirmas tu asistencia?
```

**Variables del cuerpo:**

| Var | Contenido | Ejemplo |
|---|---|---|
| `{{1}}` | Nombre de la paciente | María Pérez |
| `{{2}}` | Nombre de la doctora | Dra. Ejemplo |
| `{{3}}` | Día y fecha | martes 14 de julio |
| `{{4}}` | Hora | 10:00 |
| `{{5}}` | Consultorio (con torre/consultorio) | Clínica Sur, Consultorio 301 |

**Botones (Quick Reply):**

| Texto del botón | Payload (dinámico al enviar) |
|---|---|
| `Sí, confirmo` | `reminder_confirm_{appointmentId}` |
| `Cancelar cita` | `reminder_cancel_{appointmentId}` |

> **Nota técnica:** los payloads de Quick Reply se pasan como parámetros al
> enviar (`components` con `sub_type: "quick_reply"`), por eso podemos embeber
> el UUID de la cita. Así la respuesta de la paciente identifica la cita
> exacta sin depender del estado conversacional (que expira a los 30 min).

**Muestra para el formulario de Meta (sample values):**
`María Pérez`, `Dra. Ejemplo`, `martes 14 de julio`, `10:00`, `Clínica Sur, Consultorio 301`.

---

## Template 2: `appointment_created` (confirmación post-agendado) — NO SE SOMETE

Solo para casos edge donde el mensaje final del flujo no se entrega. En la
mayoría de los casos NO se necesita (la confirmación sale dentro de la ventana
de 24h). **Decisión Sesión 10: no someterlo por ahora** — si en producción se
detectan confirmaciones no entregadas, se somete entonces (el trámite es el
mismo en cualquier momento).

| Campo | Valor |
|---|---|
| Nombre | `appointment_created` |
| Categoría | Utility |
| Idioma | `es_MX` |
| Tipo | Solo texto |

**Cuerpo (borrador):**

```
Tu cita con la {{1}} quedó agendada ✅

📅 {{2}}
🕐 {{3}}
📍 {{4}}

Te enviaremos un recordatorio la noche anterior. Si necesitas cambiarla o cancelarla, respóndenos por aquí.
```

---

## Templates 3-8: notificaciones a la doctora — REQUERIDOS para producción

Las notificaciones a la doctora también son mensajes iniciados por el bot:
fuera de la ventana de 24h (el caso normal en producción — la doctora no
chatea con el bot), la Cloud API las rechaza con error 131047. En desarrollo
funcionan como mensajes de sesión porque el número "doctora" le escribió al
bot recientemente; en producción necesitan template.

**Estrategia (✅ implementada en `notificationService.js`, Sesión 10):** con
`DOCTOR_TEMPLATES_ENABLED=true` las notificaciones salen **directo por
template** (variables saneadas a una línea automáticamente), con el mensaje
de sesión solo como último recurso si el template falla. ¿Por qué no
sesión-primero? Meta a veces ACEPTA el mensaje de sesión y lo rechaza después
de forma asíncrona (evento `statuses` con 131047, que el webhook ignora) — el
aviso se perdería en silencio, como se observó en la prueba E2E de Sesión 10.
Costo: templates utility ~$0.01-0.02 USD c/u; con ~30-60 notificaciones/mes
son centavos.

> **Restricción de Meta importante:** las variables `{{n}}` NO pueden contener
> saltos de línea, tabs ni 4+ espacios seguidos. Por eso las notas de la
> paciente viajan como una sola línea, y la estructura multilínea vive en el
> cuerpo fijo del template.

Todos: categoría **Utility**, idioma **es_MX**, solo texto (sin botones).

### Template 3: `doctor_new_appointment`

```
🆕 Nueva cita agendada desde el asistente del consultorio ({{1}}):

👤 Paciente: {{2}}
📞 Teléfono: {{3}}
📅 Fecha: {{4}} a las {{5}}
📍 Consultorio: {{6}}
🏥 Consulta: {{7}}

💬 Notas de la paciente: {{8}}

La cita ya quedó registrada en tu calendario.
```

| Var | Contenido | Ejemplo |
|---|---|---|
| `{{1}}` | Tipo de paciente | paciente nueva / paciente recurrente |
| `{{2}}` | Nombre | María Pérez |
| `{{3}}` | Teléfono | +52 55 1234 5678 |
| `{{4}}` | Día y fecha | martes 14 de julio |
| `{{5}}` | Hora | 10:00 |
| `{{6}}` | Consultorio | Clínica Norte |
| `{{7}}` | Tipo y duración | Consulta de primera vez (40 min) |
| `{{8}}` | Notas en una línea | Sin notas |

### Template 4: `doctor_confirmation`

```
✅ Confirmación recibida: {{1}} confirmó su cita de mañana a las {{2}} en {{3}}. No necesitas hacer nada.
```

`{{1}}` nombre · `{{2}}` hora · `{{3}}` consultorio

**Samples:** `María Pérez` · `10:00` · `Clínica Norte`

### Template 5: `doctor_cancellation`

```
❌ Aviso de cancelación: {{1}} canceló su cita.
📅 Era: {{2}} a las {{3}} en {{4}}
El horario quedó liberado en tu calendario.
```

`{{1}}` nombre · `{{2}}` día y fecha · `{{3}}` hora · `{{4}}` consultorio

**Samples:** `María Pérez` · `martes 14 de julio` · `10:00` · `Clínica Sur`

### Template 6: `doctor_no_response`

```
⚠️ Pendiente de confirmar: {{1}} no ha respondido al recordatorio de su cita de mañana a las {{2}} en {{3}}.
La cita sigue en pie. Si quieres contactarla directamente, su teléfono es {{4}} (también puedes esperar a que responda).
```

`{{1}}` nombre · `{{2}}` hora · `{{3}}` consultorio · `{{4}}` teléfono

**Samples:** `María Pérez` · `10:00` · `Clínica Norte` · `+52 55 1234 5678`

### Template 7: `doctor_reschedule`

```
🔄 Cambio de cita: {{1}} reagendó desde el asistente.
❌ Antes: {{2}}
✅ Ahora: {{3}}
📍 Consultorio: {{4}}
Tu calendario ya quedó actualizado.
```

`{{1}}` nombre · `{{2}}` fecha y hora viejas · `{{3}}` fecha y hora nuevas · `{{4}}` consultorio

**Samples:** `María Pérez` · `martes 14 de julio, 10:00` · `jueves 16 de julio, 09:40` · `Clínica Sur`

### Template 8: `doctor_alert` (escalaciones y avisos técnicos)

Genérico para los dos casos poco frecuentes: escalación de reagendamiento
("no encontré horarios para X, ¿le marcas?") y alerta de error técnico.

```
🔔 Aviso del asistente del consultorio:
{{1}}
Este mensaje se generó automáticamente. Si algo se ve raro, avísale al equipo técnico.
```

`{{1}}` = el aviso en una sola línea.

**Sample:** `María Pérez quiere reagendar su cita (Consulta subsecuente, Clínica Norte) pero no encontré horarios disponibles. Su cita original sigue en pie. ¿Le marcas? Tel: +52 55 1234 5678`

> **Riesgo de rechazo:** los templates casi 100% variables a veces los rechaza
> el revisor de Meta. Si pasa, dividirlo en dos templates específicos
> (escalación / error) con más texto fijo.

> **Priorización si no quieren someter los 6:** los imprescindibles son
> `doctor_new_appointment`, `doctor_cancellation` y `doctor_no_response`
> (avisos que llegan a cualquier hora). Confirmación y reagendamiento suelen
> ocurrir cerca de una interacción de la paciente, pero la ventana que importa
> es la de la DOCTORA, así que lo seguro es someterlos todos — la aprobación
> es el mismo trámite.

---

## Templates 9-10: lista de espera — REQUERIDOS para producción

Agregados con la actualización del 19/08/2026 (lista de espera). Ambos con
Quick Reply Buttons y payloads dinámicos al enviar (mismo mecanismo que
`appointment_reminder`).

### Template 9: `doctor_waitlist_offer`

Aviso a la doctora de un hueco liberado que puede ofrecer a la lista de
espera. Su tap en cualquier botón abre su ventana de 24h: el resto de la
interacción (la lista de candidatas) viaja como mensajes de sesión gratis.
Se reusa también cuando una paciente rechaza la oferta ({{1}} cambia).

> **Desde el 23/09** el botón "Elegir paciente" abre la lista **completa** en
> texto (antes, un List Message limitado a 9 pacientes) y la doctora elige
> escribiendo el nombre. El template no se re-sometió: el payload `wl_view_`
> no cambió. La versión de sesión del botón dice "Ver lista de espera".

| Campo | Valor |
|---|---|
| Nombre | `doctor_waitlist_offer` |
| Categoría | **Utility** |
| Idioma | `es_MX` |
| Tipo | Texto + 2 Quick Reply Buttons |

**Cuerpo:**

```
🔔 Lista de espera: {{1}}

🕐 Horario disponible: {{2}}, {{3}}
📍 {{4}}
👥 En lista de espera con cita más lejana: {{5}}

¿Se lo ofrecemos a alguna paciente?
```

| Var | Contenido | Ejemplo |
|---|---|---|
| `{{1}}` | Qué pasó (una línea) | María Pérez canceló y su horario quedó libre. |
| `{{2}}` | Día y fecha del hueco | lunes 24 de agosto |
| `{{3}}` | Hora del hueco | 13:00 |
| `{{4}}` | Consultorio | Clínica Sur |
| `{{5}}` | Nº de candidatas | 3 |

**Botones (Quick Reply):**

| Texto del botón | Payload (dinámico al enviar) |
|---|---|
| `Elegir paciente` | `wl_view_{offerId}` |
| `Dejar libre` | `wl_skip_{offerId}` |

**Samples:** `María Pérez canceló y su horario quedó libre.` · `lunes 24 de agosto` · `13:00` · `Clínica Sur` · `3`

### Template 10: `waitlist_slot_offer`

Oferta del hueco liberado a la paciente que la doctora eligió. Es un mensaje
iniciado por el bot fuera de la ventana de 24h de la paciente (el caso normal:
su última interacción fue al agendar, días atrás).

| Campo | Valor |
|---|---|
| Nombre | `waitlist_slot_offer` |
| Categoría | **Utility** |
| Idioma | `es_MX` |
| Tipo | Texto + 2 Quick Reply Buttons |

**Cuerpo:**

```
Hola {{1}} 👋, se liberó un espacio con la {{2}} y te lo está ofreciendo:

📅 {{3}}
🕐 {{4}}
📍 {{5}}

Si lo aceptas, tu cita del {{6}} se cambia a este nuevo horario. ¿Te acomoda?
```

| Var | Contenido | Ejemplo |
|---|---|---|
| `{{1}}` | Nombre de la paciente | María Pérez |
| `{{2}}` | Nombre de la doctora | Dra. Ejemplo |
| `{{3}}` | Día y fecha del hueco | lunes 24 de agosto |
| `{{4}}` | Hora del hueco | 13:00 |
| `{{5}}` | Consultorio (con torre/piso) | Clínica Sur, Piso 3, Consultorio 301 |
| `{{6}}` | Fecha de su cita actual | martes 15 de septiembre |

**Botones (Quick Reply):**

| Texto del botón | Payload (dinámico al enviar) |
|---|---|
| `Sí, lo tomo` | `wloffer_accept_{offerId}` |
| `No me acomoda` | `wloffer_decline_{offerId}` |

**Samples:** `María Pérez` · `Dra. Ejemplo` · `lunes 24 de agosto` · `13:00` · `Clínica Sur, Piso 3, Consultorio 301` · `martes 15 de septiembre`

> **Al aprobarse**, además de las dos env vars del checklist general:
> `WAITLIST_OFFER_TEMPLATE_NAME=waitlist_slot_offer` en Railway.
> `doctor_waitlist_offer` no necesita env var: se activa junto con
> `DOCTOR_TEMPLATES_ENABLED=true`.

> **Nota:** el mensaje de información de Clínica Norte (el otro
> requerimiento del 19/08/2026) NO necesita template — se envía a media
> conversación de agendado, dentro de la ventana de 24h.

---

## Checklist de sometimiento 

- [x] Someter `appointment_reminder` (con Quick Reply Buttons — límite 25 chars por botón; los botones de template NO aceptan emojis, a diferencia de los de sesión)
- [x] Someter `doctor_new_appointment`
- [x] Someter `doctor_confirmation`
- [x] Someter `doctor_cancellation`
- [x] Someter `doctor_no_response`
- [x] Someter `doctor_reschedule`
- [x] Someter `doctor_alert`
- [x] Someter `doctor_waitlist_offer` (con 2 Quick Reply Buttons)
- [x] Someter `waitlist_slot_offer` (con 2 Quick Reply Buttons)
- [x] Anotar la fecha de sometimiento para dar seguimiento (aprueban en 3-7 días)

Pendientes de datos que NO bloquean el sometimiento (los templates usan
variables, no estos datos): piso y consultorio de
cada sede (`detail` en `src/data/availability.json`), y `DOCTOR_NAME`
si la doctora quiere otro nombre visible (hoy "Dra. Ejemplo" — viaja como
variable `{{2}}` del recordatorio, editable sin re-someter).

## Cómo someterlos (paso a paso)

1. Meta Business Suite → **WhatsApp Manager** → Plantillas de mensaje → **Crear plantilla**.
2. Categoría **Utility** (crítico — no Marketing), idioma **Spanish (MEX)**.
3. Nombre EXACTO del template (minúsculas y guiones bajos, como aparece aquí).
4. Pegar el cuerpo con las variables `{{n}}` tal cual.
5. Llevan botones `appointment_reminder`, `doctor_waitlist_offer` y `waitlist_slot_offer`: agregar 2 **Quick Reply** con los textos de sus tablas (los payloads NO se configuran aquí — se pasan dinámicos al enviar).
6. Llenar los **sample values** indicados en cada template (Meta los pide para evaluar).
7. Enviar y esperar aprobación (3-7 días). El estado se ve en la misma consola; Meta también avisa por correo.
8. **Al aprobarse, en las variables de Railway:**
   - `REMINDER_TEMPLATE_NAME=appointment_reminder`
   - `DOCTOR_TEMPLATES_ENABLED=true`
   - `WAITLIST_OFFER_TEMPLATE_NAME=waitlist_slot_offer`
   (redeploy automático al guardar — sin tocar código).

Redacción conservadora = menos riesgo de rechazo: sin promociones, sin urgencia
artificial, solo información de la cita. Si Meta rechaza, apelar desde la
consola o ajustar redacción y re-someter.
