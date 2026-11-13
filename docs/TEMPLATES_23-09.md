# Templates de Meta nuevos — actualización del 23/09/2026

> **Qué hay que hacer:** someter **2 templates nuevos** en WhatsApp Manager.
> Son avisos a la doctora que el bot inicia por su cuenta (su ventana de 24h
> suele estar cerrada), así que Meta exige template aprobado.
>
> **No bloquean el deploy.** Mientras Meta no los apruebe, el bot manda esos
> avisos por el template genérico `doctor_alert` (ya aprobado) con una versión
> de una línea. Cuando Meta los apruebe, el bot los empieza a usar solo: **no
> hay env vars nuevas ni redeploy**.
>
> Los nombres son contrato con el código (`DOCTOR_TEMPLATE_BY_EVENT` en
> `src/services/notificationService.js`) y **el orden de las variables
> también**: crear cada template EXACTAMENTE como aparece aquí.

⚠️ **Gotcha de la Sesión 13:** los templates viven en la **WABA**, no en el
número. Hay que crearlos en la WABA **real del consultorio**, no en la "Test
WhatsApp Business Account" (si se crean en la de Test, el número real responde
`132001 Template name does not exist in the translation`).

---

## Template 11: `doctor_reminder_undelivered` — REQUERIDO

Aviso a la doctora cuando Meta reporta que **no pudo entregarle el
recordatorio a una paciente** (status `failed` del webhook — el bug del
23/09). Sale en el momento, para que la doctora contacte a la paciente antes
de la cita; ya no le llega el engañoso "no ha confirmado" dos horas después.

| Campo | Valor |
|---|---|
| Nombre | `doctor_reminder_undelivered` |
| Categoría | **Utility** |
| Idioma | Spanish (MEX) — `es_MX` |
| Tipo | Solo texto (sin botones) |

**Cuerpo:**

```
⚠️ Recordatorio no entregado: WhatsApp no pudo entregarle a {{1}} el recordatorio de su cita del {{2}} a las {{3}} en {{4}}.
La cita sigue en pie, pero ella no sabe que debe confirmar. Te sugiero contactarla directamente al {{5}} para confirmar su asistencia.
```

| Var | Contenido | Ejemplo |
|---|---|---|
| `{{1}}` | Nombre de la paciente | María Pérez |
| `{{2}}` | Día y fecha de la cita | jueves 25 de septiembre |
| `{{3}}` | Hora | 10:00 |
| `{{4}}` | Consultorio | Clínica Norte |
| `{{5}}` | Teléfono de la paciente | +5215512345678 |

**Samples:** `María Pérez` · `jueves 25 de septiembre` · `10:00` · `Clínica Norte` · `+5215512345678`

---

## Template 12: `doctor_calendar_removed` — REQUERIDO

Aviso a la doctora cuando el bot detecta que **ella borró a mano de su
calendario el evento de una cita del bot** y no hay nadie en la lista de
espera para ese horario. Le confirma que el bot también la canceló y que ya
no le mandará recordatorio a esa paciente.

> Si SÍ hay pacientes en lista de espera, este template no se usa: el aviso
> sale por el `doctor_waitlist_offer` ya aprobado, con {{1}} = "Quitaste de
> tu calendario la cita de X y su horario quedó libre."

| Campo | Valor |
|---|---|
| Nombre | `doctor_calendar_removed` |
| Categoría | **Utility** |
| Idioma | Spanish (MEX) — `es_MX` |
| Tipo | Solo texto (sin botones) |

**Cuerpo:**

```
🗓️ Cita quitada de tu calendario: la cita de {{1}} del {{2}} a las {{3}} en {{4}} ya no aparece en tu calendario.
La cancelé también en el asistente, así que no le enviaré recordatorio y el horario quedó libre para agendar. Si la quitaste por error, pídele a la paciente que vuelva a agendar por WhatsApp.
```

| Var | Contenido | Ejemplo |
|---|---|---|
| `{{1}}` | Nombre de la paciente | María Pérez |
| `{{2}}` | Día y fecha de la cita | jueves 25 de septiembre |
| `{{3}}` | Hora | 10:00 |
| `{{4}}` | Consultorio | Clínica Sur |

**Samples:** `María Pérez` · `jueves 25 de septiembre` · `10:00` · `Clínica Sur`

---

## Mensajes nuevos que NO necesitan template

| Mensaje | Por qué no |
|---|---|
| Lista de espera completa en texto | Responde al tap de la doctora en "Elegir paciente" / "Ver lista de espera": su ventana de 24h está abierta |
| Detalle de una paciente (con botones "Ofrecerle horario" / "Dejar libre") | Responde a un nombre que la doctora acaba de escribir |
| "No encontré a esa paciente" / "Encontré varias" | Ídem |
| Cita quitada del calendario **con** candidatas en lista de espera | Sale por `doctor_waitlist_offer` (ya aprobado); solo cambia el texto de `{{1}}` |
| Oferta de lista de espera **no entregada** a la paciente | Sale por `doctor_waitlist_offer` (si quedan candidatas) o `doctor_alert` (si no) — ambos ya aprobados |
| Freno de seguridad del sync con calendario ("algo raro con el calendario") | Sale por `doctor_alert` (ya aprobado; su cierre "avísale al equipo técnico" encaja) |

**Sobre `doctor_waitlist_offer`:** se decidió **no** editarlo. Su botón sigue
diciendo "Elegir paciente" en el template aprobado (el payload no cambió, así
que funciona igual) y ahora abre la lista completa en texto. El botón de la
versión de sesión dice "Ver lista de espera" (el límite de botones de sesión es
de 20 caracteres, así que "Mostrar lista de espera" no cabía). Si algún día se
quiere igualar el texto del template, se edita en WhatsApp Manager (el límite de
botones de template es de 25 caracteres), sin tocar código.

---

## Checklist de sometimiento

- [ ] Someter `doctor_reminder_undelivered` en la **WABA real** (Utility, Spanish (MEX), sin botones)
- [ ] Someter `doctor_calendar_removed` en la **WABA real** (Utility, Spanish (MEX), sin botones)
- [ ] Confirmar que ambos quedaron en **Active** (y siguen en categoría **Utility**)
- [ ] Nada más: no hay env vars nuevas. `DOCTOR_TEMPLATES_ENABLED=true` (ya puesto en Railway) cubre los templates nuevos

Mismo paso a paso que `docs/TEMPLATES.md` → "Cómo someterlos". Si Meta
rechaza por ratio de variables, agregar más texto fijo **sin cambiar el
número ni el orden de las variables**.
