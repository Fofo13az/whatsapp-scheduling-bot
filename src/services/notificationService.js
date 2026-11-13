/**
 * notificationService — avisos a la doctora en su WhatsApp personal.
 *
 * Todo aviso sale del número del bot hacia DOCTOR_PERSONAL_PHONE, controlado
 * por los toggles NOTIFY_* del .env. La diferenciación paciente
 * nueva vs. recurrente se resuelve aquí (consulta a patients/appointments),
 * no en los flujos.
 *
 * Regla de resiliencia: notificar a la doctora es SECUNDARIO al flujo de la
 * paciente. Ninguna función de este módulo lanza — los errores se loggean y
 * se traga la excepción. Si la notificación no sale, la cita/cancelación ya
 * quedó registrada y la doctora la ve en su calendario.
 *
 * Ventana de 24h: los mensajes a la doctora son iniciados por el bot; fuera
 * de la ventana la Cloud API los rechaza con 131047. Estrategia (Fase 4):
 * con DOCTOR_TEMPLATES_ENABLED activo, los avisos salen DIRECTO por template
 * (docs/TEMPLATES.md, templates 3-8), con el mensaje de sesión solo como
 * último recurso si el template falla. ¿Por qué no sesión-primero? Porque
 * Meta a veces ACEPTA el mensaje de sesión (devuelve wamid) y lo rechaza
 * después de forma asíncrona (evento `statuses` con 131047, que el webhook
 * ignora) — el aviso se perdería en silencio, como pasó en la prueba E2E de
 * la Sesión 10. El template elimina esa incertidumbre por ~$0.01-0.02 USD.
 * Con el toggle apagado (default — mientras Meta no apruebe los templates),
 * se intenta el mensaje de sesión y el rechazo por ventana solo se loggea.
 */

import consultationTypes from '../data/consultationTypes.json' with { type: 'json' };
import { locationLabel } from '../data/locations.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { messages } from '../data/messages.js';
import * as patientRepository from './patientRepository.js';
import { sendMessage, sendTemplate } from './whatsappClient.js';
import { buildTextMessage, buildWaitlistDoctorPrompt } from './messageBuilder.js';
import { formatLongDateEs, getClinicParts } from '../lib/dates.js';

const log = logger.child({ module: 'notificationService' });

// Códigos de Meta que significan "no se puede iniciar conversación de sesión"
// (131047 = ventana de 24h cerrada / re-engagement, 131026 = no entregable).
// Se usan para loggear el caso como warning accionable en vez de error.
const WINDOW_CLOSED_CODES = new Set([131047, 131026]);

// Evento → nombre del template aprobado en Meta (docs/TEMPLATES.md 3-8 y
// docs/TEMPLATES_23-09.md). Los nombres son parte del contrato con WhatsApp
// Manager, no secretos.
const DOCTOR_TEMPLATE_BY_EVENT = {
  new_appointment: 'doctor_new_appointment',
  confirmation: 'doctor_confirmation',
  cancellation: 'doctor_cancellation',
  no_response: 'doctor_no_response',
  reschedule: 'doctor_reschedule',
  reschedule_escalation: 'doctor_alert',
  system_error: 'doctor_alert',
  waitlist_notice: 'doctor_alert',
  calendar_sync_alert: 'doctor_alert',
  // Actualización 23/09 — si Meta aún no los aprueba (132001), safeSend cae
  // a doctor_alert con la versión de una línea, sin tocar config.
  reminder_undelivered: 'doctor_reminder_undelivered',
  calendar_removed: 'doctor_calendar_removed',
};

// Template genérico ya aprobado: red de seguridad para los templates
// dedicados que todavía no existan en la WABA.
const ALERT_TEMPLATE = 'doctor_alert';

// Template con Quick Reply Buttons para el aviso de hueco liberado
// (docs/TEMPLATES.md template 9). Va aparte del mapeo body-only de arriba
// porque lleva components de botón con payloads dinámicos.
const WAITLIST_PROMPT_TEMPLATE = 'doctor_waitlist_offer';

/**
 * Cita nueva agendada. Notificación completa para paciente nueva, concisa
 * para recurrente (según historial de citas completadas).
 *
 * @param {object} appointment  Forma de appointmentRepository (camelCase)
 */
export async function notifyNewAppointment(appointment) {
  if (!config.NOTIFY_NEW_APPOINTMENT) return;

  const { dateLabel, timeLabel } = appointmentLabels(appointment);

  await safeSend(
    'new_appointment',
    async () => {
      const isRecurring = await patientRepository.hasCompletedAppointments(appointment.patientPhone);
      const common = {
        name: appointment.patientName,
        dateLabel,
        timeLabel,
        locationLabel: locationLabel(appointment.location),
        typeLabel: typeLabelOf(appointment.consultationType),
        notes: appointment.patientNotes,
      };

      return isRecurring
        ? messages.doctor.newAppointmentRecurring(common)
        : messages.doctor.newAppointmentNewPatient({
            ...common,
            phone: appointment.patientPhone,
            durationMin: appointment.durationMin,
          });
    },
    // Params del template doctor_new_appointment ({{1}}..{{8}} — TEMPLATES.md)
    async () => {
      const isRecurring = await patientRepository.hasCompletedAppointments(appointment.patientPhone);
      return [
        isRecurring ? 'paciente recurrente' : 'paciente nueva',
        appointment.patientName,
        `+${appointment.patientPhone}`,
        dateLabel,
        timeLabel,
        locationLabel(appointment.location),
        `${typeLabelOf(appointment.consultationType)} (${appointment.durationMin} min)`,
        appointment.patientNotes ?? 'Sin notas',
      ];
    },
  );
}

/**
 * La paciente confirmó su cita en respuesta al recordatorio nocturno.
 *
 * @param {object} appointment
 */
export async function notifyConfirmation(appointment) {
  if (!config.NOTIFY_CONFIRMATION) return;

  const { timeLabel } = appointmentLabels(appointment);

  await safeSend(
    'confirmation',
    () =>
      messages.doctor.confirmation({
        name: appointment.patientName,
        timeLabel,
        locationLabel: locationLabel(appointment.location),
      }),
    () => [appointment.patientName, timeLabel, locationLabel(appointment.location)],
  );
}

/**
 * La paciente canceló su cita (desde el recordatorio o el flujo de cancelación).
 *
 * @param {object} appointment
 */
export async function notifyCancellation(appointment) {
  if (!config.NOTIFY_CANCELLATION) return;

  const { dateLabel, timeLabel } = appointmentLabels(appointment);

  await safeSend(
    'cancellation',
    () =>
      messages.doctor.cancellation({
        name: appointment.patientName,
        dateLabel,
        timeLabel,
        locationLabel: locationLabel(appointment.location),
      }),
    () => [appointment.patientName, dateLabel, timeLabel, locationLabel(appointment.location)],
  );
}

/**
 * La paciente no respondió al recordatorio nocturno (chequeo de seguimiento
 * del scheduler, un rato después de enviado el recordatorio).
 *
 * @param {object} appointment
 */
export async function notifyNoResponse(appointment) {
  if (!config.NOTIFY_NO_RESPONSE) return;

  const { timeLabel } = appointmentLabels(appointment);

  await safeSend(
    'no_response',
    () =>
      messages.doctor.noResponse({
        name: appointment.patientName,
        timeLabel,
        locationLabel: locationLabel(appointment.location),
        phone: appointment.patientPhone,
      }),
    () => [
      appointment.patientName,
      timeLabel,
      locationLabel(appointment.location),
      `+${appointment.patientPhone}`,
    ],
  );
}

/**
 * La paciente reagendó: cita vieja → cita nueva.
 *
 * @param {object} oldAppointment
 * @param {object} newAppointment
 */
export async function notifyReschedule(oldAppointment, newAppointment) {
  if (!config.NOTIFY_RESCHEDULE) return;

  const oldLabels = appointmentLabels(oldAppointment);
  const newLabels = appointmentLabels(newAppointment);

  await safeSend(
    'reschedule',
    () =>
      messages.doctor.reschedule({
        name: newAppointment.patientName,
        oldDateLabel: oldLabels.dateLabel,
        oldTimeLabel: oldLabels.timeLabel,
        newDateLabel: newLabels.dateLabel,
        newTimeLabel: newLabels.timeLabel,
        locationLabel: locationLabel(newAppointment.location),
      }),
    () => [
      newAppointment.patientName,
      `${oldLabels.dateLabel}, ${oldLabels.timeLabel}`,
      `${newLabels.dateLabel}, ${newLabels.timeLabel}`,
      locationLabel(newAppointment.location),
    ],
  );
}

/**
 * Escalación: la paciente quiso reagendar pero no hubo horarios disponibles.
 * No lleva toggle — la escalación es parte del flujo, no un aviso
 * informativo opcional.
 *
 * @param {object} appointment  La cita original (sigue en pie)
 */
export async function notifyRescheduleEscalation(appointment) {
  const details = {
    name: appointment.patientName,
    phone: appointment.patientPhone,
    typeLabel: typeLabelOf(appointment.consultationType),
    locationLabel: locationLabel(appointment.location),
  };

  await safeSend(
    'reschedule_escalation',
    () => messages.doctor.rescheduleEscalation(details),
    () => [messages.doctor.rescheduleEscalationOneLine(details)],
  );
}

/**
 * Meta reportó que el recordatorio NO se entregó a la paciente (status
 * failed del webhook). Sin toggle: es una falla operativa — si la doctora no
 * se entera, la paciente se queda sin saber que debe confirmar (bug 23/09).
 *
 * @param {object} appointment
 */
export async function notifyReminderUndelivered(appointment) {
  const { dateLabel, timeLabel } = appointmentLabels(appointment);
  const details = {
    name: appointment.patientName,
    dateLabel,
    timeLabel,
    locationLabel: locationLabel(appointment.location),
    phone: appointment.patientPhone,
  };

  await safeSend(
    'reminder_undelivered',
    () => messages.doctor.reminderUndelivered(details),
    // Params de doctor_reminder_undelivered ({{1}}..{{5}} — TEMPLATES_23-09.md)
    () => [details.name, dateLabel, timeLabel, details.locationLabel, `+${details.phone}`],
    () => messages.doctor.reminderUndeliveredOneLine(details),
  );
}

/**
 * La doctora quitó a mano el evento de una cita de su calendario y NO había
 * candidatas en la lista de espera (con candidatas, el aviso es el de lista
 * de espera con su propio headline). Sin toggle: le confirma que el bot ya
 * no le mandará recordatorio a esa paciente.
 *
 * @param {object} appointment
 */
export async function notifyCalendarRemoved(appointment) {
  const { dateLabel, timeLabel } = appointmentLabels(appointment);
  const details = {
    name: appointment.patientName,
    dateLabel,
    timeLabel,
    locationLabel: locationLabel(appointment.location),
  };

  await safeSend(
    'calendar_removed',
    () => messages.doctor.calendarRemoved(details),
    // Params de doctor_calendar_removed ({{1}}..{{4}} — TEMPLATES_23-09.md)
    () => [details.name, dateLabel, timeLabel, details.locationLabel],
    () => messages.doctor.calendarRemovedOneLine(details),
  );
}

/**
 * Freno de seguridad del sync con calendario: demasiadas anomalías a la vez
 * (probable falla de conexión o de configuración, no cambios de la doctora).
 *
 * @param {{ anomalies: number, total: number }} counts
 */
export async function notifyCalendarSyncAnomaly(counts) {
  const line = messages.doctor.calendarSyncAnomalyOneLine(counts);
  await safeSend('calendar_sync_alert', () => `⚠️ ${line}`, () => [line]);
}

// ─── Lista de espera ─────────────────────────────────────────────────────────

/**
 * Aviso a la doctora de un hueco liberado que puede ofrecerse a la lista de
 * espera, con botones "Elegir paciente" / "Dejar libre" (payloads con el UUID
 * de la oferta — se resuelven sin estado, como los recordatorios).
 *
 * Sin toggle: es parte del flujo de lista de espera, no un aviso opcional.
 * Con DOCTOR_TEMPLATES_ENABLED sale por el template doctor_waitlist_offer
 * (misma estrategia template-directo que safeSend); su tap en el botón abre
 * la ventana de 24h y el resto de la interacción (lista de candidatas) viaja
 * como mensajes de sesión. Nunca lanza.
 *
 * @param {{ id: string, location: string, scheduledAt: Date | string }} offer
 * @param {string} headline  Primera línea del aviso (quién canceló / rechazó)
 * @param {number} candidateCount
 */
export async function notifyWaitlistPrompt(offer, headline, candidateCount) {
  const { dateLabel, timeLabel } = appointmentLabels(offer);
  const locLabel = locationLabel(offer.location);

  if (config.DOCTOR_TEMPLATES_ENABLED) {
    try {
      await sendTemplate(config.DOCTOR_PERSONAL_PHONE, WAITLIST_PROMPT_TEMPLATE, [
        {
          type: 'body',
          parameters: [headline, dateLabel, timeLabel, locLabel, String(candidateCount)]
            .map((text) => ({ type: 'text', text: sanitizeTemplateParam(text) })),
        },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '0',
          parameters: [{ type: 'payload', payload: `wl_view_${offer.id}` }],
        },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '1',
          parameters: [{ type: 'payload', payload: `wl_skip_${offer.id}` }],
        },
      ]);
      log.info({ offerId: offer.id }, 'Aviso de lista de espera enviado a la doctora vía template');
      return;
    } catch (err) {
      log.error(
        { err, offerId: offer.id },
        'Falló el template de lista de espera — intentando mensaje de sesión como último recurso',
      );
    }
  }

  try {
    const body = messages.doctor.waitlistPrompt({
      headline,
      dateLabel,
      timeLabel,
      locationLabel: locLabel,
      candidateCount,
    });
    await sendMessage(buildWaitlistDoctorPrompt(config.DOCTOR_PERSONAL_PHONE, offer.id, body));
    log.info({ offerId: offer.id }, 'Aviso de lista de espera enviado a la doctora');
  } catch (err) {
    if (WINDOW_CLOSED_CODES.has(err?.metaCode) && !config.DOCTOR_TEMPLATES_ENABLED) {
      log.warn(
        { offerId: offer.id, metaCode: err.metaCode },
        'Ventana de 24h cerrada y DOCTOR_TEMPLATES_ENABLED=false — aviso de lista de espera no enviado',
      );
      return;
    }
    log.error({ err, offerId: offer.id }, 'No se pudo enviar el aviso de lista de espera a la doctora');
  }
}

/**
 * Aviso simple (sin botones) de un desenlace de lista de espera que el bot
 * inicia — ej. "ya no hay más candidatas" o "el hueco se ocupó por otra vía".
 * El texto debe ser de UNA línea (viaja como {{1}} de doctor_alert).
 *
 * @param {string} text
 */
export async function notifyWaitlistNotice(text) {
  await safeSend('waitlist_notice', () => text, () => [text]);
}

// ─── Alerta de error de sistema ──────────────────────────────────────────────

// Throttle en memoria para no inundar a la doctora si algo truena en cascada
// (ej. DB caída mientras llegan 20 mensajes): máx. una alerta por contexto
// cada ERROR_THROTTLE_MS.
const ERROR_THROTTLE_MS = 10 * 60 * 1000;
const lastErrorNotifiedAt = new Map(); // context → timestamp

/**
 * Error inesperado procesando mensajes. Siempre activo (sin toggle): es la
 * red de seguridad del patrón de error handling de CLAUDE.md.
 *
 * @param {string} context  Descripción corta para la doctora, ej. "flujo de agendado"
 */
export async function notifySystemError(context) {
  const now = Date.now();
  const last = lastErrorNotifiedAt.get(context) ?? 0;
  if (now - last < ERROR_THROTTLE_MS) return;
  lastErrorNotifiedAt.set(context, now);

  await safeSend(
    'system_error',
    () => messages.doctor.systemError({ context }),
    () => [messages.doctor.systemErrorOneLine({ context })],
  );
}

// ─── Internos ────────────────────────────────────────────────────────────────

/**
 * Envía la notificación a la doctora, tragándose cualquier error (con log).
 *
 * Con DOCTOR_TEMPLATES_ENABLED: template directo (entrega garantizada sin
 * depender de la ventana de 24h). Si falla (ej. template dedicado que Meta
 * aún no aprueba → 132001) y hay `buildAlertLine`, reintenta con el genérico
 * doctor_alert; el mensaje de sesión de `buildText` queda como último recurso.
 *
 * Sin el toggle: mensaje de sesión; si rebota por ventana cerrada se loggea
 * como warning accionable (encender el toggle cuando Meta apruebe).
 *
 * `buildText`, `buildTemplateParams` y `buildAlertLine` pueden ser async (ej.
 * consultan el historial). `buildTemplateParams` devuelve las variables {{n}}
 * del template en orden, como array de strings; `buildAlertLine`, el aviso en
 * una línea para el {{1}} de doctor_alert.
 */
async function safeSend(event, buildText, buildTemplateParams, buildAlertLine = null) {
  if (config.DOCTOR_TEMPLATES_ENABLED && buildTemplateParams) {
    const templateName = DOCTOR_TEMPLATE_BY_EVENT[event];
    if (await trySendDoctorTemplate(event, templateName, buildTemplateParams)) return;

    if (buildAlertLine && templateName !== ALERT_TEMPLATE) {
      const alertParams = async () => [await buildAlertLine()];
      if (await trySendDoctorTemplate(event, ALERT_TEMPLATE, alertParams)) return;
    }
  }

  try {
    const text = await buildText();
    await sendMessage(buildTextMessage(config.DOCTOR_PERSONAL_PHONE, text));
    log.info({ event }, 'Notificación enviada a la doctora');
  } catch (err) {
    if (WINDOW_CLOSED_CODES.has(err?.metaCode) && !config.DOCTOR_TEMPLATES_ENABLED) {
      log.warn(
        { event, metaCode: err.metaCode },
        'Ventana de 24h cerrada y DOCTOR_TEMPLATES_ENABLED=false — notificación no enviada (encender el toggle cuando Meta apruebe los templates)',
      );
      return;
    }
    log.error({ err, event }, 'No se pudo notificar a la doctora');
  }
}

/**
 * Un intento de template a la doctora. Devuelve true si Meta lo aceptó; los
 * errores se loggean y el caller decide el siguiente recurso.
 */
async function trySendDoctorTemplate(event, templateName, buildParams) {
  try {
    const params = (await buildParams()).map(sanitizeTemplateParam);
    await sendTemplate(config.DOCTOR_PERSONAL_PHONE, templateName, [
      { type: 'body', parameters: params.map((text) => ({ type: 'text', text })) },
    ]);
    log.info({ event, templateName }, 'Notificación enviada a la doctora vía template');
    return true;
  } catch (err) {
    log.error(
      { err, event, templateName },
      'Falló el template a la doctora — intentando el siguiente recurso',
    );
    return false;
  }
}

/**
 * Meta rechaza variables de template con saltos de línea, tabs o 4+ espacios
 * seguidos, y no acepta params vacíos.
 */
function sanitizeTemplateParam(value) {
  const oneLine = String(value ?? '').replace(/\s+/g, ' ').trim();
  return oneLine || '—';
}

function typeLabelOf(consultationType) {
  return consultationTypes[consultationType]?.label ?? consultationType;
}

/**
 * Etiquetas de presentación (hora del consultorio) desde el scheduledAt UTC.
 *
 * @param {{ scheduledAt: Date | string }} appointment
 * @returns {{ dateLabel: string, timeLabel: string }}
 */
function appointmentLabels(appointment) {
  const scheduledAt = new Date(appointment.scheduledAt);
  const parts = getClinicParts(scheduledAt);
  return {
    dateLabel: formatLongDateEs(scheduledAt),
    timeLabel: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
  };
}
