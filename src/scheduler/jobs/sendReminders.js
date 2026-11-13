/**
 * sendReminders — job nocturno de recordatorios (REMINDER_TIME, hora CDMX).
 *
 * Busca las citas de MAÑANA (día calendario del consultorio) que siguen
 * activas y sin recordatorio, y les manda el recordatorio con botones de
 * confirmar/cancelar. Idempotente: getForReminderRange filtra por
 * reminder_sent_at IS NULL, así que correrlo dos veces no duplica envíos.
 *
 * Canal de envío:
 *   - Con REMINDER_TEMPLATE_NAME configurado → template de Meta con payloads
 *     dinámicos en los Quick Reply (producción, fuera de ventana de 24h).
 *   - Sin configurar → mensaje interactivo de sesión (desarrollo con el
 *     número de test; requiere ventana de 24h abierta con la paciente).
 *
 * Antes de decidir a quién recordar, se sincronizan las citas con el
 * calendario (calendarSync, actualización 23/09): si la doctora BORRÓ a mano
 * el evento de una cita, esa cita ya no recibe recordatorio (se cancela en el
 * bot); si lo MOVIÓ, el recordatorio sale con el horario nuevo — y si lo
 * movió a otro día, lo manda la corrida de ese día. Si el calendario no
 * responde, todo sigue como antes (fail-open).
 *
 * Cada cita se procesa de forma independiente: si un envío falla, se loggea
 * y se continúa con las demás (esa cita reintenta mañana... no: su cita ya
 * habrá pasado — por eso el fallo también dispara notifySystemError para que
 * quede rastro).
 */

import { config } from '../../config/index.js';
import { locationFullLabel } from '../../data/locations.js';
import { logger } from '../../lib/logger.js';
import * as appointmentRepository from '../../services/appointmentRepository.js';
import * as calendarSync from '../../services/calendarSync.js';
import * as notificationService from '../../services/notificationService.js';
import { sendMessage, sendTemplate } from '../../services/whatsappClient.js';
import { buildReminderMessage } from '../../services/messageBuilder.js';
import {
  addDays,
  clinicTimeToUtc,
  formatLongDateEs,
  getClinicParts,
} from '../../lib/dates.js';

const log = logger.child({ module: 'sendReminders' });

/**
 * Corre el job. Devuelve un resumen para logging/smoke tests.
 *
 * @param {Date} [now]  Inyectable para pruebas
 * @returns {Promise<{ total: number, sent: number, failed: number }>}
 */
export async function runSendReminders(now = new Date()) {
  await syncWithCalendar();

  const { startUtc, endUtc } = tomorrowRangeUtc(now);
  const appointments = await appointmentRepository.getForReminderRange(startUtc, endUtc);

  if (appointments.length === 0) {
    log.info({ startUtc, endUtc }, 'Sin citas para recordar mañana');
    return { total: 0, sent: 0, failed: 0 };
  }

  log.info({ count: appointments.length }, 'Enviando recordatorios');
  let sent = 0;
  let failed = 0;

  for (const appointment of appointments) {
    try {
      const { messageId } = await sendReminderTo(appointment);
      // El wamid correlaciona los statuses de entrega de Meta (statusHandler):
      // "enviado" aquí solo significa que Meta lo ACEPTÓ.
      await appointmentRepository.markReminderSent(appointment.id, messageId);
      sent += 1;
    } catch (err) {
      failed += 1;
      log.error(
        { err, appointmentId: appointment.id, patientPhone: appointment.patientPhone },
        'Fallo al enviar recordatorio',
      );
    }
  }

  if (failed > 0) {
    await notificationService.notifySystemError('envío de recordatorios');
  }

  log.info({ total: appointments.length, sent, failed }, 'Job de recordatorios terminado');
  return { total: appointments.length, sent, failed };
}

// ─── Internos ────────────────────────────────────────────────────────────────

/**
 * Refleja en la DB los cambios manuales de la doctora antes de elegir a quién
 * recordar. Nunca lanza: si el sync falla, los recordatorios salen con los
 * datos de la DB, como antes de la actualización 23/09.
 */
async function syncWithCalendar() {
  try {
    await calendarSync.runCalendarSync({ context: 'previo a recordatorios' });
  } catch (err) {
    log.error({ err }, 'Falló el sync con calendario previo a los recordatorios — se envían con los datos de la DB');
  }
}

async function sendReminderTo(appointment) {
  const scheduledAt = new Date(appointment.scheduledAt);
  const parts = getClinicParts(scheduledAt);
  const params = {
    name: appointment.patientName,
    dateLabel: formatLongDateEs(scheduledAt),
    timeLabel: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    locationLabel: locationFullLabel(appointment.location),
  };

  if (config.REMINDER_TEMPLATE_NAME) {
    return sendTemplate(
      appointment.patientPhone,
      config.REMINDER_TEMPLATE_NAME,
      reminderTemplateComponents(appointment.id, params),
    );
  }

  return sendMessage(buildReminderMessage(appointment.patientPhone, appointment.id, params));
}

/**
 * Components del template appointment_reminder (docs/TEMPLATES.md):
 * 5 variables de cuerpo + payload dinámico en cada Quick Reply para que la
 * respuesta identifique la cita.
 */
function reminderTemplateComponents(appointmentId, { name, dateLabel, timeLabel, locationLabel }) {
  return [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: name },
        { type: 'text', text: config.DOCTOR_NAME },
        { type: 'text', text: dateLabel },
        { type: 'text', text: timeLabel },
        { type: 'text', text: locationLabel },
      ],
    },
    {
      type: 'button',
      sub_type: 'quick_reply',
      index: '0',
      parameters: [{ type: 'payload', payload: `reminder_confirm_${appointmentId}` }],
    },
    {
      type: 'button',
      sub_type: 'quick_reply',
      index: '1',
      parameters: [{ type: 'payload', payload: `reminder_cancel_${appointmentId}` }],
    },
  ];
}

/**
 * Rango UTC del día calendario de MAÑANA en la zona del consultorio:
 * [mañana 00:00 CDMX, pasado mañana 00:00 CDMX).
 */
function tomorrowRangeUtc(now) {
  const today = getClinicParts(now);
  const startUtc = clinicTimeToUtc({
    ...getClinicParts(addDays(clinicTimeToUtc({ ...today, hour: 12, minute: 0 }), 1)),
    hour: 0,
    minute: 0,
    second: 0,
  });
  return { startUtc, endUtc: addDays(startUtc, 1) };
}
