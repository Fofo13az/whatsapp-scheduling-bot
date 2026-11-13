/**
 * calendarSync — detecta los cambios que la doctora hace A MANO en su
 * calendario sobre citas que agendó el bot (actualización 23/09).
 *
 * El caso que lo originó: la doctora movió la cita de una paciente creando un
 * evento nuevo y borrando el del bot; el bot, que decidía solo con MySQL, le
 * mandó el recordatorio de la cita vieja. Ahora, antes de cada recordatorio
 * (sendReminders) y en un barrido diario de todas las citas futuras, cada cita
 * se compara con su evento de calendario (por el UID guardado). Con el sync
 * previo al envío, una cita movida HACIA mañana también recibe su recordatorio:
 *
 *   - ok            → el evento sigue a la misma hora.
 *   - moved         → la doctora ARRASTRÓ el evento a otra hora/día: la cita
 *                     adopta el horario nuevo (sin avisos: ella lo movió).
 *   - deleted       → la doctora BORRÓ el evento: la cita se cancela en el bot
 *                     (sin escribirle a la paciente — la doctora ya lo arregló
 *                     con ella), se ofrece el hueco a la lista de espera y se
 *                     le confirma a la doctora.
 *   - unverifiable  → sin UID, sin calendario, calendario caído o evento
 *                     ilegible: no se toca nada y todo sigue como antes
 *                     (fail-open — mejor mandar el recordatorio que omitirlo).
 *
 * Freno de seguridad: primero se verifica TODO el lote y después se aplica.
 * Si las anomalías (movidas + borradas) son demasiadas para ser cambios de la
 * doctora, no se aplica nada, se loggea y se avisa (probable falla de
 * conexión/configuración o un bug — nunca cancelar citas en masa).
 */

import { logger } from '../lib/logger.js';
import { messages } from '../data/messages.js';
import { MS_PER_MINUTE } from '../lib/dates.js';
import * as appointmentRepository from './appointmentRepository.js';
import * as calendarService from './calendarService.js';
import * as notificationService from './notificationService.js';
import * as waitlistService from './waitlistService.js';

const log = logger.child({ module: 'calendarSync' });

// Diferencia mínima de inicio para considerar que el evento se movió.
const MOVE_TOLERANCE_MS = MS_PER_MINUTE;

// Duraciones razonables de una cita movida; fuera de rango se conserva la
// duración original (ej. la doctora estiró el evento para bloquear la tarde).
const MIN_DURATION_MIN = 10;
const MAX_DURATION_MIN = 240;

// Freno de seguridad: se bloquea el lote si las anomalías superan
// max(ANOMALY_MIN, ANOMALY_RATIO × citas verificadas). Las no verificables no
// cuentan en la proporción: no dicen nada sobre si el calendario es confiable.
const ANOMALY_MIN = 3;
const ANOMALY_RATIO = 0.3;

/**
 * Compara una cita con su evento de calendario. No escribe nada.
 *
 * @param {object} appointment  Forma de appointmentRepository
 * @returns {Promise<{ status: 'ok' } | { status: 'moved', start: Date, durationMin: number }
 *   | { status: 'deleted' } | { status: 'unverifiable', reason: string }>}
 */
export async function verifyAppointment(appointment) {
  if (!appointment.caldavEventUid) return { status: 'unverifiable', reason: 'la cita no tiene evento de calendario' };
  if (!calendarService.isConfigured()) return { status: 'unverifiable', reason: 'calendario sin configurar' };

  let event;
  try {
    event = await calendarService.getEvent({
      uid: appointment.caldavEventUid,
      location: appointment.location,
    });
  } catch (err) {
    log.warn({ err, appointmentId: appointment.id }, 'No se pudo verificar la cita contra el calendario');
    return { status: 'unverifiable', reason: err.message };
  }

  if (event.status === 'missing') return { status: 'deleted' };
  if (event.allDay) {
    // Un evento de la cita convertido a "todo el día" no dice a qué hora es.
    return { status: 'unverifiable', reason: 'el evento de la cita ahora es de todo el día' };
  }

  const scheduledAt = new Date(appointment.scheduledAt);
  if (Math.abs(event.start.getTime() - scheduledAt.getTime()) < MOVE_TOLERANCE_MS) {
    return { status: 'ok' };
  }

  const eventDurationMin = Math.round((event.end.getTime() - event.start.getTime()) / MS_PER_MINUTE);
  const durationMin = eventDurationMin >= MIN_DURATION_MIN && eventDurationMin <= MAX_DURATION_MIN
    ? eventDurationMin
    : appointment.durationMin;
  return { status: 'moved', start: event.start, durationMin };
}

/**
 * Verifica un lote de citas contra el calendario y aplica los cambios de la
 * doctora (si pasan el freno de seguridad).
 *
 * Cada resultado trae `applied`: true si el cambio (moved/deleted) quedó
 * aplicado en la DB. Con el freno activado, o si la cita dejó de estar activa
 * mientras tanto (ej. la paciente la canceló por WhatsApp), applied=false y
 * la cita debe tratarse como antes de esta revisión.
 *
 * @param {object[]} appointments
 * @param {{ context: string }} options  Para logs ("recordatorios", "barrido diario")
 * @returns {Promise<{ results: Array<{ appointment: object, status: string, applied: boolean,
 *   start?: Date, durationMin?: number, reason?: string }>, blocked: boolean }>}
 */
export async function reconcileAppointments(appointments, { context }) {
  const results = [];
  for (const appointment of appointments) {
    results.push({ appointment, applied: false, ...(await verifyAppointment(appointment)) });
  }

  const anomalies = results.filter((r) => r.status === 'moved' || r.status === 'deleted');
  const verified = results.filter((r) => r.status !== 'unverifiable').length;
  const threshold = Math.max(ANOMALY_MIN, Math.floor(ANOMALY_RATIO * verified));
  const blocked = anomalies.length > threshold;

  if (blocked) {
    log.error(
      {
        context,
        total: results.length,
        anomalies: anomalies.map((r) => ({ appointmentId: r.appointment.id, status: r.status })),
      },
      'Freno de seguridad del sync con calendario: demasiadas citas movidas/borradas a la vez — no se aplica nada',
    );
    await notificationService.notifyCalendarSyncAnomaly({ anomalies: anomalies.length, total: verified });
    return { results, blocked };
  }

  for (const result of anomalies) {
    result.applied = await applyChange(result);
  }

  log.info(
    {
      context,
      total: results.length,
      moved: results.filter((r) => r.status === 'moved' && r.applied).length,
      deleted: results.filter((r) => r.status === 'deleted' && r.applied).length,
      unverifiable: results.filter((r) => r.status === 'unverifiable').length,
    },
    'Sync con calendario terminado',
  );
  return { results, blocked };
}

/**
 * Sincroniza todas las citas activas futuras con evento. Corre en el barrido
 * diario (scheduler, 07:00) y justo antes de los recordatorios. Libera
 * horarios de citas borradas a mano, mantiene al día las fechas que ve la
 * doctora en la lista de espera y deja cada cita movida en su día correcto
 * para el recordatorio.
 *
 * @param {{ context?: string }} [options]  Para logs
 * @returns {Promise<{ total: number, blocked: boolean, results: object[] }>}
 */
export async function runCalendarSync({ context = 'barrido diario' } = {}) {
  if (!calendarService.isConfigured()) {
    log.info({ context }, 'Calendario sin configurar — sync omitido');
    return { total: 0, blocked: false, results: [] };
  }

  const appointments = await appointmentRepository.getActiveFutureWithEvent();
  const { results, blocked } = await reconcileAppointments(appointments, { context });
  return { total: results.length, blocked, results };
}

// ─── Internos ────────────────────────────────────────────────────────────────

/** @returns {Promise<boolean>} true si el cambio se aplicó */
async function applyChange(result) {
  // Releer: entre la verificación y ahora la paciente pudo cancelar o
  // reagendar por WhatsApp (y el evento desapareció por ESO, no por la doctora).
  const fresh = await appointmentRepository.getById(result.appointment.id);
  if (!fresh || (fresh.status !== 'pending' && fresh.status !== 'confirmed')) {
    log.info({ appointmentId: result.appointment.id, status: fresh?.status }, 'La cita ya no está activa — sin cambios del sync');
    return false;
  }

  if (result.status === 'moved') {
    await appointmentRepository.updateSchedule(fresh.id, result.start, result.durationMin);
    log.info(
      { appointmentId: fresh.id, from: fresh.scheduledAt, to: result.start, durationMin: result.durationMin },
      'Cita movida a mano en el calendario — horario actualizado en el bot',
    );
    return true;
  }

  await appointmentRepository.markCancelled(fresh.id);
  log.info(
    { appointmentId: fresh.id, patientPhone: fresh.patientPhone, scheduledAt: fresh.scheduledAt },
    'Evento de la cita borrado a mano del calendario — cita cancelada en el bot',
  );

  // Con candidatas en lista de espera, el aviso de hueco liberado ya le dice
  // a la doctora qué pasó; sin candidatas, aviso propio.
  const prompted = await waitlistService.onSlotFreed(fresh, {
    headline: messages.doctor.calendarRemovedHeadline({ name: fresh.patientName }),
  });
  if (!prompted) await notificationService.notifyCalendarRemoved(fresh);
  return true;
}
