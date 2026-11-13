/**
 * Constructor de payloads de mensajes salientes.
 *
 * Devuelve objetos JS neutrales (no acoplados a ningún proveedor).
 * `whatsappClient` los traduce al wire format de la Cloud API de Meta al
 * momento de enviar. Esto permite testear sin red y migrar el proveedor sin
 * tocar la lógica de mensajes (así migramos de Twilio a Meta sin tocar este
 * módulo salvo el formato de teléfono).
 *
 * Tres tipos de payload:
 *   - text:    { type: 'text', to, body }
 *   - buttons: { type: 'buttons', to, body, buttons: [{ id, label }] }    (máx 3)
 *   - list:    { type: 'list', to, body, buttonText, sections: [{ title, items }] }
 *
 * Convención de IDs (alineada con el parseo entrante en
 * whatsappWebhook.js): `{contexto}_{valor}`.
 *   type_primera_vez · loc_sur · date_13/05/2026 · slot_13/05/2026_10:00
 *   confirm_yes · reminder_confirm
 */

import consultationTypes from '../data/consultationTypes.json' with { type: 'json' };
import { LOCATION_KEYS, locationButtonLabel } from '../data/locations.js';
import { messages, buttonLabels } from '../data/messages.js';

// ── Límites de WhatsApp (Cloud API) ─────────────────────────────────────────
const LIMITS = {
  bodyMaxChars: 1024,          // cuerpo de mensajes interactivos (botones / lista)
  textBodyMaxChars: 4096,      // mensaje de texto plano
  buttonLabelMaxChars: 20,
  listButtonTextMaxChars: 20,
  listSectionTitleMaxChars: 24,
  listItemLabelMaxChars: 24,
  listItemDescriptionMaxChars: 72,
  buttonsMaxCount: 3,
  listItemsMaxCount: 10,
};

const DEFAULT_LIST_BUTTON_TEXT = 'Ver opciones';

// ── Helpers internos ────────────────────────────────────────────────────────

/**
 * Cuenta codepoints, no UTF-16 code units. Necesario para emojis: "✅".length === 1
 * pero "👨‍👩‍👧".length === 8 aunque visualmente es 1. Array.from() itera codepoints.
 */
function codepointLength(str) {
  return Array.from(str).length;
}

// Acepta wa_id (dígitos, como llega en el webhook: "5215512345678") o E.164
// con "+" (como DOCTOR_PERSONAL_PHONE). whatsappClient normaliza al enviar.
function assertTo(to) {
  if (typeof to !== 'string' || !/^\+?[1-9]\d{7,14}$/.test(to)) {
    throw new Error(`messageBuilder: "to" debe ser un teléfono E.164 (con o sin "+"), recibido: ${JSON.stringify(to)}`);
  }
}

function assertBody(body, max = LIMITS.bodyMaxChars) {
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error('messageBuilder: "body" debe ser un string no vacío');
  }
  if (codepointLength(body) > max) {
    throw new Error(`messageBuilder: "body" excede ${max} caracteres (${codepointLength(body)})`);
  }
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`messageBuilder: "${fieldName}" debe ser un string no vacío`);
  }
}

function assertMaxLength(value, max, fieldName) {
  if (codepointLength(value) > max) {
    throw new Error(`messageBuilder: "${fieldName}" excede ${max} caracteres (${codepointLength(value)}): ${JSON.stringify(value)}`);
  }
}

function assertUniqueIds(ids) {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`messageBuilder: ID duplicado "${id}" — todos los IDs del mensaje deben ser únicos`);
    }
    seen.add(id);
  }
}

// ── Builders de bajo nivel (puros, sin dependencias de data/*) ──────────────

/**
 * Mensaje de texto plano.
 *
 * @param {string} to    Destinatario: wa_id o E.164 (ej. "5215512345678" o "+5215512345678")
 * @param {string} body  Texto del mensaje (≤4096 chars — límite de Meta para texto)
 * @returns {{ type: 'text', to: string, body: string }}
 */
export function buildTextMessage(to, body) {
  assertTo(to);
  assertBody(body, LIMITS.textBodyMaxChars);
  return { type: 'text', to, body };
}

/**
 * Texto que puede rebasar el límite de un mensaje (ej. la lista de espera
 * completa): se parte en varios mensajes de texto, cortando SOLO entre
 * líneas para no partir un renglón a la mitad.
 *
 * @param {string} to
 * @param {string} body
 * @param {number} [maxChars]  Inyectable para pruebas
 * @returns {Array<{ type: 'text', to: string, body: string }>}
 */
export function buildLongTextMessages(to, body, maxChars = LIMITS.textBodyMaxChars) {
  assertTo(to);
  assertNonEmptyString(body, 'body');

  const chunks = [];
  let current = '';
  for (const line of body.split('\n')) {
    if (codepointLength(line) > maxChars) {
      throw new Error(`messageBuilder: una sola línea excede ${maxChars} caracteres`);
    }
    const candidate = current === '' ? line : `${current}\n${line}`;
    if (codepointLength(candidate) <= maxChars) {
      current = candidate;
    } else {
      chunks.push(current);
      current = line;
    }
  }
  chunks.push(current);

  return chunks
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => buildTextMessage(to, chunk));
}

/**
 * Mensaje con Reply Buttons (1 a 3 botones).
 *
 * @param {string} to
 * @param {string} body
 * @param {Array<{ id: string, label: string }>} buttons
 * @returns {{ type: 'buttons', to: string, body: string, buttons: Array<{id: string, label: string}> }}
 */
export function buildButtonsMessage(to, body, buttons) {
  assertTo(to);
  assertBody(body);

  if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > LIMITS.buttonsMaxCount) {
    throw new Error(`messageBuilder: se requieren entre 1 y ${LIMITS.buttonsMaxCount} botones, recibidos ${buttons?.length ?? 0}`);
  }

  for (const [i, btn] of buttons.entries()) {
    assertNonEmptyString(btn?.id, `buttons[${i}].id`);
    assertNonEmptyString(btn?.label, `buttons[${i}].label`);
    assertMaxLength(btn.label, LIMITS.buttonLabelMaxChars, `buttons[${i}].label`);
  }

  assertUniqueIds(buttons.map((b) => b.id));

  return {
    type: 'buttons',
    to,
    body,
    buttons: buttons.map(({ id, label }) => ({ id, label })),
  };
}

/**
 * List Message (botón "Ver opciones" que abre un menú agrupado en secciones).
 *
 * @param {string} to
 * @param {string} body
 * @param {string} buttonText                Texto del botón que abre el menú (≤20 chars)
 * @param {Array<{ title: string, items: Array<{ id: string, label: string, description?: string }> }>} sections
 * @returns {{ type: 'list', to: string, body: string, buttonText: string, sections: Array<object> }}
 */
export function buildListMessage(to, body, buttonText, sections) {
  assertTo(to);
  assertBody(body);
  assertNonEmptyString(buttonText, 'buttonText');
  assertMaxLength(buttonText, LIMITS.listButtonTextMaxChars, 'buttonText');

  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('messageBuilder: "sections" debe ser un array con al menos una sección');
  }

  let totalItems = 0;
  const allIds = [];

  const normalizedSections = sections.map((section, sIdx) => {
    assertNonEmptyString(section?.title, `sections[${sIdx}].title`);
    assertMaxLength(section.title, LIMITS.listSectionTitleMaxChars, `sections[${sIdx}].title`);

    if (!Array.isArray(section.items) || section.items.length === 0) {
      throw new Error(`messageBuilder: sections[${sIdx}].items debe ser un array no vacío`);
    }

    const items = section.items.map((item, iIdx) => {
      const path = `sections[${sIdx}].items[${iIdx}]`;
      assertNonEmptyString(item?.id, `${path}.id`);
      assertNonEmptyString(item?.label, `${path}.label`);
      assertMaxLength(item.label, LIMITS.listItemLabelMaxChars, `${path}.label`);

      if (item.description !== undefined && item.description !== null) {
        assertNonEmptyString(item.description, `${path}.description`);
        assertMaxLength(item.description, LIMITS.listItemDescriptionMaxChars, `${path}.description`);
      }

      allIds.push(item.id);
      totalItems += 1;

      const normalized = { id: item.id, label: item.label };
      if (item.description) normalized.description = item.description;
      return normalized;
    });

    return { title: section.title, items };
  });

  if (totalItems > LIMITS.listItemsMaxCount) {
    throw new Error(`messageBuilder: el list message excede ${LIMITS.listItemsMaxCount} items totales (${totalItems}) — pagina del lado del caller`);
  }

  assertUniqueIds(allIds);

  return {
    type: 'list',
    to,
    body,
    buttonText,
    sections: normalizedSections,
  };
}

// ── Builders de alto nivel (componen con messages.js + data estática) ──────

/**
 * Selección de tipo de consulta desde consultationTypes.json. Con 3 tipos o
 * menos usa Reply Buttons (un toque directo); con más, List Message.
 *
 * @param {string} to
 */
export function buildTypeSelectionMessage(to) {
  const entries = Object.entries(consultationTypes).filter(([key]) => !key.startsWith('_'));

  if (entries.length <= LIMITS.buttonsMaxCount) {
    const buttons = entries.map(([key, def]) => ({
      id: `type_${key}`,
      label: def.shortLabel ?? def.label,
    }));
    return {
      ...buildButtonsMessage(to, messages.appointment.selectType, buttons),
      kind: 'type_selection',
    };
  }

  const items = entries.map(([key, def]) => ({
    id: `type_${key}`,
    label: def.shortLabel ?? def.label,
    description: def.description,
  }));

  return {
    ...buildListMessage(
      to,
      messages.appointment.selectType,
      DEFAULT_LIST_BUTTON_TEXT,
      [{ title: 'Tipos de consulta', items }],
    ),
    kind: 'type_selection',
  };
}

/**
 * Selección de consultorio. Reply Buttons con las ubicaciones de
 * availability.json (label corto: el nombre completo va en los mensajes).
 *
 * @param {string} to
 */
export function buildLocationSelectionMessage(to) {
  const buttons = LOCATION_KEYS.map((key) => ({
    id: `loc_${key}`,
    label: locationButtonLabel(key),
  }));

  return {
    ...buildButtonsMessage(to, messages.appointment.selectLocation, buttons),
    kind: 'location_selection',
  };
}

/**
 * Indicaciones de llegada de un consultorio (firstVisitInfo) con botón de
 * continuar. Se envía una sola vez por paciente, la primera vez que agenda
 * en ese consultorio (appointmentFlow, estado SHOWING_LOCATION_INFO).
 *
 * @param {string} to
 * @param {string} info  Texto de firstVisitInfo de availability.json
 */
export function buildLocationInfoMessage(to, info) {
  assertNonEmptyString(info, 'info');
  return {
    ...buildButtonsMessage(to, messages.appointment.locationInfo({ info }), [
      { id: 'locinfo_continue', label: buttonLabels.continue },
    ]),
    kind: 'location_info',
  };
}

/**
 * Selección de fecha. List message con hasta 5 fechas disponibles.
 *
 * @param {string} to
 * @param {Array<{ date: string, label: string }>} dates  date en formato DD/MM/YYYY; label legible para la paciente
 */
export function buildDateSelectionMessage(to, dates) {
  if (!Array.isArray(dates) || dates.length === 0) {
    throw new Error('buildDateSelectionMessage: se requiere al menos una fecha');
  }
  if (dates.length > 5) {
    throw new Error(`buildDateSelectionMessage: máximo 5 fechas, recibidas ${dates.length}`);
  }

  const items = dates.map(({ date, label }) => ({
    id: `date_${date}`,
    label,
  }));

  return {
    ...buildListMessage(
      to,
      messages.appointment.selectDate,
      DEFAULT_LIST_BUTTON_TEXT,
      [{ title: 'Fechas disponibles', items }],
    ),
    kind: 'date_selection',
  };
}

// Con más de 10 slots (límite duro de WhatsApp) se pagina: 9 horarios por
// página + el item "Ver más horarios". Un día de 8:00 a 16:00 en bloques de
// 40 min tiene 12 slots — sin esto, los últimos jamás se ofrecían.
const SLOTS_PER_PAGE = LIMITS.listItemsMaxCount - 1;
export const SHOW_MORE_SLOTS_ID = 'slot_more';

/**
 * Vista paginada de los slots de un día. Con ≤10 slots es una sola página
 * completa; con más, páginas de 9 (el décimo item es "Ver más horarios").
 * `page` se clampa al rango válido (el estado conversacional puede traer una
 * página vieja si los slots se recalcularon).
 *
 * @param {string[]} slots
 * @param {number} [page]  0-based
 * @returns {{ visible: string[], hasMore: boolean, page: number, pageCount: number }}
 */
export function slotPageView(slots, page = 0) {
  if (slots.length <= LIMITS.listItemsMaxCount) {
    return { visible: slots, hasMore: false, page: 0, pageCount: 1 };
  }
  const pageCount = Math.ceil(slots.length / SLOTS_PER_PAGE);
  const clamped = Math.min(Math.max(page, 0), pageCount - 1);
  const start = clamped * SLOTS_PER_PAGE;
  const visible = slots.slice(start, start + SLOTS_PER_PAGE);
  return { visible, hasMore: start + SLOTS_PER_PAGE < slots.length, page: clamped, pageCount };
}

/**
 * Selección de horario para una fecha. List message paginado (ver slotPageView).
 *
 * @param {string} to
 * @param {string} date        DD/MM/YYYY, usado para construir el ID del slot
 * @param {string} dateLabel   Etiqueta legible para incluir en el body
 * @param {string[]} slots     TODOS los slots libres del día, en formato HH:mm
 * @param {number} [page]      Página a mostrar (0-based)
 */
export function buildTimeSelectionMessage(to, date, dateLabel, slots, page = 0) {
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new Error('buildTimeSelectionMessage: se requiere al menos un slot');
  }

  const view = slotPageView(slots, page);
  const items = view.visible.map((time) => ({
    id: `slot_${date}_${time}`,
    label: time,
  }));
  if (view.hasMore) {
    items.push({ id: SHOW_MORE_SLOTS_ID, label: buttonLabels.moreSlots });
  }

  const body = messages.appointment.selectTime({ dateLabel })
    + (view.pageCount > 1 ? `\n\n${messages.appointment.slotsPageHint({ page: view.page + 1, pageCount: view.pageCount })}` : '');

  return {
    ...buildListMessage(
      to,
      body,
      DEFAULT_LIST_BUTTON_TEXT,
      [{ title: 'Horarios disponibles', items }],
    ),
    kind: 'time_selection',
  };
}

/**
 * Confirmación final de la cita. Reply Buttons con confirmar / cancelar / reiniciar.
 *
 * @param {string} to
 * @param {{ typeLabel: string, locationLabel: string, dateLabel: string, timeLabel: string, name: string, notes?: string }} summary
 */
export function buildConfirmationMessage(to, summary) {
  const body = messages.appointment.confirm(summary);

  const buttons = [
    { id: 'confirm_yes', label: buttonLabels.confirm },
    { id: 'confirm_no', label: buttonLabels.cancel },
    { id: 'confirm_restart', label: buttonLabels.startOver },
  ];

  return {
    ...buildButtonsMessage(to, body, buttons),
    kind: 'confirmation',
  };
}

/**
 * Recordatorio nocturno con botones de confirmación. En producción este
 * mensaje viaja como template aprobado por Meta (appointment_reminder,
 * docs/TEMPLATES.md); aquí armamos la versión de fallback dentro de la
 * ventana de 24h (y pruebas con el número de test).
 *
 * Los IDs llevan el UUID de la cita (reminder_confirm_{id}) para que la
 * respuesta identifique la cita exacta sin depender del estado conversacional
 * — la paciente puede contestar horas después, ya expirado el TTL de 30 min.
 *
 * @param {string} to
 * @param {string} appointmentId  UUID de la cita
 * @param {{ name: string, dateLabel: string, timeLabel: string, locationLabel: string }} params
 */
export function buildReminderMessage(to, appointmentId, params) {
  assertNonEmptyString(appointmentId, 'appointmentId');
  const body = messages.reminder.body(params);

  const buttons = [
    { id: `reminder_confirm_${appointmentId}`, label: buttonLabels.reminderConfirm },
    { id: `reminder_cancel_${appointmentId}`, label: buttonLabels.reminderCancel },
  ];

  return {
    ...buildButtonsMessage(to, body, buttons),
    kind: 'reminder',
  };
}

/**
 * Confirmación de cancelación de una cita. Reply Buttons sí/no; el ID lleva
 * el UUID de la cita para validar contra lo ofrecido.
 *
 * @param {string} to
 * @param {string} appointmentId
 * @param {{ dateLabel: string, timeLabel: string, locationLabel: string }} summary
 */
export function buildCancelConfirmationMessage(to, appointmentId, summary) {
  assertNonEmptyString(appointmentId, 'appointmentId');
  const body = messages.cancellation.confirmCancel(summary);

  const buttons = [
    { id: `cancel_yes_${appointmentId}`, label: buttonLabels.cancelYes },
    { id: `cancel_no_${appointmentId}`, label: buttonLabels.cancelNo },
  ];

  return {
    ...buildButtonsMessage(to, body, buttons),
    kind: 'cancel_confirmation',
  };
}

/**
 * Selección de cita activa (cuando la paciente tiene varias) para cancelar o
 * reagendar. List message con una cita por item.
 *
 * @param {string} to
 * @param {string} body       Texto del mensaje (selectAppointment de cancelación o reagendamiento)
 * @param {Array<{ id: string, shortLabel: string, timeLabel: string, locationLabel: string }>} options
 */
export function buildAppointmentSelectionMessage(to, body, options) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('buildAppointmentSelectionMessage: se requiere al menos una cita');
  }
  if (options.length > LIMITS.listItemsMaxCount) {
    throw new Error(`buildAppointmentSelectionMessage: máximo ${LIMITS.listItemsMaxCount} citas, recibidas ${options.length}`);
  }

  const items = options.map((opt) => ({
    id: `appt_${opt.id}`,
    label: `${opt.shortLabel} · ${opt.timeLabel}`,
    description: opt.locationLabel,
  }));

  return {
    ...buildListMessage(to, body, DEFAULT_LIST_BUTTON_TEXT, [
      { title: 'Tus citas activas', items },
    ]),
    kind: 'appointment_selection',
  };
}

// ── Lista de espera ─────────────────────────────────────────────────────────
// Todos los IDs llevan los UUIDs necesarios para resolverse sin estado
// conversacional (doctora y paciente responden horas después, con el TTL de
// 30 min muerto) — misma técnica que los botones del recordatorio.

/**
 * Invitación a la lista de espera, enviada tras agendar una cita lejana.
 *
 * @param {string} to
 * @param {string} appointmentId  La cita lejana recién creada
 * @param {{ dateLabel: string }} params
 */
export function buildWaitlistInviteMessage(to, appointmentId, { dateLabel }) {
  assertNonEmptyString(appointmentId, 'appointmentId');
  return {
    ...buildButtonsMessage(to, messages.waitlist.invite({ dateLabel }), [
      { id: `wl_join_${appointmentId}`, label: buttonLabels.waitlistJoin },
      { id: `wl_no_${appointmentId}`, label: buttonLabels.waitlistNo },
    ]),
    kind: 'waitlist_invite',
  };
}

/**
 * Aviso a la doctora de un hueco liberado, con botones para ver la lista de
 * candidatas o dejarlo libre (versión de sesión; en producción el primer
 * aviso sale por el template doctor_waitlist_offer con estos mismos payloads).
 *
 * @param {string} to  DOCTOR_PERSONAL_PHONE
 * @param {string} offerId
 * @param {string} body  messages.doctor.waitlistPrompt(...)
 */
export function buildWaitlistDoctorPrompt(to, offerId, body) {
  assertNonEmptyString(offerId, 'offerId');
  return {
    ...buildButtonsMessage(to, body, [
      { id: `wl_view_${offerId}`, label: buttonLabels.waitlistView },
      { id: `wl_skip_${offerId}`, label: buttonLabels.waitlistSkip },
    ]),
    kind: 'waitlist_doctor_prompt',
  };
}

/**
 * Detalle de una paciente de la lista de espera (la doctora escribió su
 * nombre), con botones para ofrecerle el hueco o dejarlo libre. La doctora
 * también puede ignorar los botones y escribir otro nombre.
 *
 * @param {string} to  DOCTOR_PERSONAL_PHONE
 * @param {string} offerId
 * @param {string} waitlistId
 * @param {string} body  messages.doctor.waitlistPatientDetail(...)
 */
export function buildWaitlistPatientDetailMessage(to, offerId, waitlistId, body) {
  assertNonEmptyString(offerId, 'offerId');
  assertNonEmptyString(waitlistId, 'waitlistId');
  return {
    ...buildButtonsMessage(to, body, [
      { id: `wl_pick_${offerId}_${waitlistId}`, label: buttonLabels.waitlistPick },
      { id: `wl_skip_${offerId}`, label: buttonLabels.waitlistSkip },
    ]),
    kind: 'waitlist_patient_detail',
  };
}

// ── Lista de espera a voluntad (revisión 25/09) ────────────────────────────
// La doctora escribe "lista de espera", elige a una paciente y le busca un
// horario. Igual que el resto de la lista de espera, cada ID lleva todo lo
// necesario (entrada, consultorio, fecha, hora): los taps no dependen de
// estado conversacional y se re-validan al llegar.

/**
 * Detalle de una paciente desde la lista completa, con el botón para
 * buscarle horario. La doctora también puede escribir otro nombre.
 *
 * @param {string} to  DOCTOR_PERSONAL_PHONE
 * @param {string} waitlistId
 * @param {string} body  messages.doctor.waitlistPatientDetailGeneral(...)
 */
export function buildWaitlistGeneralDetailMessage(to, waitlistId, body) {
  assertNonEmptyString(waitlistId, 'waitlistId');
  return {
    ...buildButtonsMessage(to, body, [
      { id: `wl_slots_${waitlistId}`, label: buttonLabels.waitlistFindSlot },
    ]),
    kind: 'waitlist_general_detail',
  };
}

/**
 * Días con espacio para adelantar la cita de una paciente, de todos los
 * consultorios y en orden de fecha (máx. 10 filas — límite de WhatsApp).
 *
 * @param {string} to
 * @param {string} waitlistId
 * @param {string} body  messages.doctor.waitlistPickDate(...)
 * @param {Array<{ location: string, date: string, shortLabel: string, description: string }>} days
 *   date en DD/MM/YYYY; description con consultorio y número de horarios
 */
export function buildWaitlistDateSelectionMessage(to, waitlistId, body, days) {
  assertNonEmptyString(waitlistId, 'waitlistId');
  if (!Array.isArray(days) || days.length === 0) {
    throw new Error('buildWaitlistDateSelectionMessage: se requiere al menos un día');
  }

  const items = days.map(({ location, date, shortLabel, description }) => ({
    id: `wl_date_${waitlistId}_${location}_${date}`,
    label: shortLabel,
    description,
  }));

  return {
    ...buildListMessage(to, body, buttonLabels.waitlistDaysList, [{ title: 'Días con espacio', items }]),
    kind: 'waitlist_date_selection',
  };
}

/**
 * Horarios libres de un día para ofrecerle a una paciente, paginados igual
 * que en el flujo de pacientes (ver slotPageView). "Ver más horarios" lleva
 * la página siguiente en su ID.
 *
 * @param {string} to
 * @param {string} waitlistId
 * @param {string} location  slug del consultorio
 * @param {string} date      DD/MM/YYYY
 * @param {string} body      messages.doctor.waitlistPickTime(...)
 * @param {string[]} slots   TODOS los horarios libres del día ("HH:mm")
 * @param {number} [page]    0-based
 */
export function buildWaitlistTimeSelectionMessage(to, waitlistId, location, date, body, slots, page = 0) {
  assertNonEmptyString(waitlistId, 'waitlistId');
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new Error('buildWaitlistTimeSelectionMessage: se requiere al menos un horario');
  }

  const view = slotPageView(slots, page);
  const base = `${waitlistId}_${location}_${date}`;
  const items = view.visible.map((time) => ({ id: `wl_time_${base}_${time}`, label: time }));
  if (view.hasMore) {
    items.push({ id: `wl_tpage_${base}_${view.page + 1}`, label: buttonLabels.moreSlots });
  }

  const fullBody = body
    + (view.pageCount > 1 ? `\n\n${messages.appointment.slotsPageHint({ page: view.page + 1, pageCount: view.pageCount })}` : '');

  return {
    ...buildListMessage(to, fullBody, buttonLabels.waitlistTimesList, [{ title: 'Horarios disponibles', items }]),
    kind: 'waitlist_time_selection',
  };
}

/**
 * Confirmación antes de escribirle a la paciente: "Sí, ofrecérselo" manda la
 * oferta; "Otro horario" regresa a la lista de días.
 *
 * @param {string} to
 * @param {string} waitlistId
 * @param {string} location
 * @param {string} date  DD/MM/YYYY
 * @param {string} time  HH:mm
 * @param {string} body  messages.doctor.waitlistConfirmManualOffer(...)
 */
export function buildWaitlistManualConfirmMessage(to, waitlistId, location, date, time, body) {
  assertNonEmptyString(waitlistId, 'waitlistId');
  return {
    ...buildButtonsMessage(to, body, [
      { id: `wl_send_${waitlistId}_${location}_${date}_${time}`, label: buttonLabels.waitlistSendOffer },
      { id: `wl_slots_${waitlistId}`, label: buttonLabels.waitlistOtherSlot },
    ]),
    kind: 'waitlist_manual_confirm',
  };
}

/**
 * Oferta del hueco liberado a la paciente elegida, con botones de aceptar o
 * rechazar (versión de sesión; en producción sale por el template
 * waitlist_slot_offer con estos mismos payloads).
 *
 * @param {string} to
 * @param {string} offerId
 * @param {{ dateLabel: string, timeLabel: string, locationLabel: string, oldDateLabel: string }} params
 */
export function buildWaitlistOfferMessage(to, offerId, params) {
  assertNonEmptyString(offerId, 'offerId');
  return {
    ...buildButtonsMessage(to, messages.waitlist.offer(params), [
      { id: `wloffer_accept_${offerId}`, label: buttonLabels.waitlistAccept },
      { id: `wloffer_decline_${offerId}`, label: buttonLabels.waitlistDecline },
    ]),
    kind: 'waitlist_offer',
  };
}
