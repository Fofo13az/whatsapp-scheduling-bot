/**
 * checkNoResponses — seguimiento del recordatorio nocturno.
 *
 * Corre REMINDER_FOLLOWUP_HOURS después del envío de recordatorios y avisa a
 * la doctora (NOTIFY_NO_RESPONSE) de las pacientes que no han contestado:
 * citas que recibieron recordatorio hace poco y siguen en status 'pending'.
 *
 * La ventana de búsqueda se acota a recordatorios ENVIADOS RECIENTEMENTE
 * (followup + colchón) para que el aviso salga una sola vez por cita: en la
 * corrida de mañana, el recordatorio de hoy ya queda fuera de la ventana.
 */

import { config } from '../../config/index.js';
import { logger } from '../../lib/logger.js';
import * as appointmentRepository from '../../services/appointmentRepository.js';
import * as notificationService from '../../services/notificationService.js';
import { addMinutes } from '../../lib/dates.js';

const log = logger.child({ module: 'checkNoResponses' });

// Colchón sobre REMINDER_FOLLOWUP_HOURS: cubre variaciones de arranque del
// cron sin alcanzar el recordatorio de la noche anterior (mínimo ~22h de
// distancia con followup ≤ 12h y colchón de 2h).
const LOOKBACK_PADDING_MINUTES = 120;

/**
 * @param {Date} [now]  Inyectable para pruebas
 * @returns {Promise<{ unconfirmed: number }>}
 */
export async function runCheckNoResponses(now = new Date()) {
  const lookbackMinutes = config.REMINDER_FOLLOWUP_HOURS * 60 + LOOKBACK_PADDING_MINUTES;
  const sinceUtc = addMinutes(now, -lookbackMinutes);

  const unconfirmed = await appointmentRepository.getUnconfirmedReminded(sinceUtc);

  if (unconfirmed.length === 0) {
    log.info('Todas las pacientes con recordatorio respondieron (o no hubo recordatorios)');
    return { unconfirmed: 0 };
  }

  log.info({ count: unconfirmed.length }, 'Pacientes sin respuesta al recordatorio');
  for (const appointment of unconfirmed) {
    // notifyNoResponse nunca lanza (política de notificationService)
    await notificationService.notifyNoResponse(appointment);
  }

  return { unconfirmed: unconfirmed.length };
}
