/**
 * Scheduler — jobs recurrentes con node-cron, todos en hora del consultorio
 * (config.TIMEZONE — node-cron resuelve la zona internamente).
 *
 * Jobs:
 *   1. sendReminders     — REMINDER_TIME (default 20:00): recordatorio a
 *                          pacientes con cita mañana.
 *   2. checkNoResponses  — REMINDER_TIME + REMINDER_FOLLOWUP_HOURS: aviso a
 *                          la doctora de quién no ha respondido.
 *   3. nightlyMaintenance — 01:00: barrido de citas vencidas → 'completed'
 *                          (define "paciente recurrente") + limpieza de la
 *                          lista de espera (entradas de citas que ya pasaron,
 *                          ofertas vencidas). También corre una vez al
 *                          arranque para ponerse al día tras downtime.
 *   4. calendarSync      — 07:00: compara las citas futuras con el calendario
 *                          (cambios manuales de la doctora). NO corre al
 *                          arranque: cada deploy dispararía avisos. También
 *                          corre dentro de sendReminders, antes de enviar.
 *
 * Cada job atrapa sus propios errores: una corrida fallida se loggea y el
 * scheduler sigue vivo para la siguiente.
 */

import cron from 'node-cron';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import * as appointmentRepository from '../services/appointmentRepository.js';
import * as waitlistRepository from '../services/waitlistRepository.js';
import { runCalendarSync } from '../services/calendarSync.js';
import { runSendReminders } from './jobs/sendReminders.js';
import { runCheckNoResponses } from './jobs/checkNoResponses.js';

const log = logger.child({ module: 'scheduler' });

const NIGHTLY_MAINTENANCE_CRON = '0 1 * * *';
const CALENDAR_SYNC_CRON = '0 7 * * *';

let tasks = [];

/**
 * Programa los jobs y corre el barrido inicial de citas vencidas.
 * Llamar una vez al arranque, después de conectar la DB.
 */
export async function startScheduler() {
  const reminderCron = hhmmToCron(config.REMINDER_TIME);
  const followupCron = hhmmToCron(config.REMINDER_TIME, config.REMINDER_FOLLOWUP_HOURS);

  tasks = [
    schedule('sendReminders', reminderCron, () => runSendReminders()),
    schedule('checkNoResponses', followupCron, () => runCheckNoResponses()),
    schedule('nightlyMaintenance', NIGHTLY_MAINTENANCE_CRON, runNightlyMaintenance),
    schedule('calendarSync', CALENDAR_SYNC_CRON, () => runCalendarSync()),
  ];

  // Ponerse al día: citas que vencieron mientras el proceso estuvo abajo.
  await runSafely('nightlyMaintenance (arranque)', runNightlyMaintenance);

  log.info(
    {
      timezone: config.TIMEZONE,
      reminders: config.REMINDER_TIME,
      noResponseCheck: followupCron,
      calendarSync: CALENDAR_SYNC_CRON,
    },
    'Scheduler iniciado',
  );
}

/** Detiene todos los jobs (shutdown limpio). */
export function stopScheduler() {
  for (const task of tasks) task.stop();
  tasks = [];
  log.info('Scheduler detenido');
}

// ─── Internos ────────────────────────────────────────────────────────────────

/**
 * Citas vencidas → completed, y DESPUÉS la limpieza de la lista de espera
 * (que borra las entradas de citas ya no activas, incluidas las recién
 * completadas).
 */
async function runNightlyMaintenance() {
  await appointmentRepository.markCompletedBatch();
  await waitlistRepository.purgeStaleEntries();
  await waitlistRepository.closeExpiredOffers();
}

function schedule(name, cronExpression, run) {
  return cron.schedule(
    cronExpression,
    () => runSafely(name, run),
    { timezone: config.TIMEZONE },
  );
}

async function runSafely(name, run) {
  try {
    log.info({ job: name }, 'Job iniciado');
    await run();
  } catch (err) {
    log.error({ err, job: name }, 'Job falló — el scheduler sigue activo');
  }
}

/**
 * "20:00" (+ offset opcional de horas, con wrap a medianoche) → "0 20 * * *".
 */
function hhmmToCron(hhmm, offsetHours = 0) {
  const [hour, minute] = hhmm.split(':').map(Number);
  const shifted = (hour + offsetHours) % 24;
  return `${minute} ${shifted} * * *`;
}
