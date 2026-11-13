/**
 * statusHandler — acuses de entrega de los mensajes salientes (value.statuses[]
 * del webhook de Meta).
 *
 * Por qué existe (bug del 23/09): la Cloud API responde 200 + wamid en cuanto
 * ACEPTA un mensaje, pero la entrega real se confirma después, de forma
 * asíncrona, con statuses sent → delivered → read, o `failed` con el motivo.
 * Antes el webhook descartaba estos eventos, así que un recordatorio que Meta
 * no entregaba se veía en los logs como "Mensaje enviado" y nadie se enteraba.
 *
 * Qué hace:
 *   - Loggea TODO `failed` con el código y motivo de Meta (diagnóstico).
 *   - Recordatorios: avanza reminder_delivery_status; si falla, lo marca y
 *     avisa a la doctora al instante (para que contacte a la paciente).
 *   - Ofertas de lista de espera: si falla, la oferta regresa a la doctora
 *     para que elija a otra paciente (si no, se quedaría esperando una
 *     respuesta que nunca va a llegar).
 *
 * Nunca lanza: los statuses son informativos y el ack a Meta ya salió.
 */

import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { samePhone } from '../lib/phones.js';
import * as appointmentRepository from '../services/appointmentRepository.js';
import * as waitlistRepository from '../services/waitlistRepository.js';
import * as notificationService from '../services/notificationService.js';
import * as waitlistService from '../services/waitlistService.js';

const log = logger.child({ module: 'statusHandler' });

const PROGRESS_STATUSES = new Set(['sent', 'delivered', 'read']);

// El status puede llegar antes de que guardemos el wamid en la DB (Meta es
// rápido y el UPDATE va justo después del envío). Para `failed`, que es el
// que importa, se reintenta la búsqueda una vez tras una pausa corta.
const FAILED_LOOKUP_RETRY_MS = 3000;

/**
 * Procesa un elemento de value.statuses[] del webhook.
 *
 * @param {{ id: string, status: string, recipient_id?: string, timestamp?: string,
 *           errors?: Array<{ code?: number, title?: string, message?: string,
 *                            error_data?: { details?: string } }> }} status
 */
export async function handleStatusUpdate(status) {
  try {
    if (!status?.id || !status.status) return;

    if (PROGRESS_STATUSES.has(status.status)) {
      const changed = await appointmentRepository.advanceReminderDelivery(status.id, status.status);
      log.debug({ wamid: status.id, status: status.status, reminderUpdated: changed }, 'Status de entrega');
      return;
    }

    if (status.status === 'failed') {
      await handleFailed(status);
      return;
    }

    log.debug({ wamid: status.id, status: status.status }, 'Status de entrega no reconocido');
  } catch (err) {
    log.error({ err, wamid: status?.id, status: status?.status }, 'Error procesando status de entrega');
  }
}

async function handleFailed(status) {
  const reason = describeErrors(status.errors);
  const toDoctor = samePhone(status.recipient_id ?? '', config.DOCTOR_PERSONAL_PHONE);

  log.warn(
    {
      wamid: status.id,
      recipient: status.recipient_id ?? null,
      toDoctor,
      errors: status.errors ?? [],
    },
    `Meta NO entregó un mensaje saliente: ${reason}`,
  );

  // Primero por wamid: la doctora también puede ser paciente (su propio
  // recordatorio), así que el destinatario no basta para descartar.
  if (await handleFailedReminder(status.id, reason)) return;
  if (await handleFailedOffer(status.id)) return;

  // Si lo que falló fue un aviso a la doctora, no hay a quién avisarle: el log
  // de arriba es el rastro (visible en los logs de Railway).
  if (toDoctor) return;

  // Posible carrera con el guardado del wamid: un reintento.
  await new Promise((resolve) => setTimeout(resolve, FAILED_LOOKUP_RETRY_MS));
  if (await handleFailedReminder(status.id, reason)) return;
  await handleFailedOffer(status.id);
}

/** @returns {Promise<boolean>} true si el wamid era de un recordatorio */
async function handleFailedReminder(wamid, reason) {
  const appointment = await appointmentRepository.getByReminderMessageId(wamid);
  if (!appointment) return false;

  // Idempotente: Meta puede reenviar el mismo status — un solo aviso.
  const marked = await appointmentRepository.markReminderFailed(wamid, reason);
  if (!marked) return true;

  // Si la cita ya no sigue en pie (se canceló o pasó mientras llegaba el
  // status), no tiene caso pedirle a la doctora que contacte a la paciente.
  const stillActive = (appointment.status === 'pending' || appointment.status === 'confirmed')
    && new Date(appointment.scheduledAt).getTime() > Date.now();
  if (!stillActive) {
    log.warn(
      { appointmentId: appointment.id, status: appointment.status, reason },
      'Recordatorio no entregado de una cita que ya no está activa — sin aviso a la doctora',
    );
    return true;
  }

  log.error(
    { appointmentId: appointment.id, patientPhone: appointment.patientPhone, reason },
    'Recordatorio NO entregado a la paciente — avisando a la doctora',
  );
  await notificationService.notifyReminderUndelivered(appointment);
  return true;
}

/** @returns {Promise<boolean>} true si el wamid era de una oferta de lista de espera */
async function handleFailedOffer(wamid) {
  const offer = await waitlistRepository.getOfferByMessageId(wamid);
  if (!offer) return false;

  await waitlistService.onOfferUndelivered(offer);
  return true;
}

/**
 * "131026 Message undeliverable — detalle" (se guarda en la DB, máx. 255).
 *
 * @param {Array<object> | undefined} errors
 */
function describeErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return 'sin detalle de Meta';
  return errors
    .map((e) => {
      const details = e.error_data?.details;
      const base = [e.code, e.title ?? e.message].filter(Boolean).join(' ');
      return details && details !== e.title ? `${base} — ${details}` : base;
    })
    .join(' | ');
}
