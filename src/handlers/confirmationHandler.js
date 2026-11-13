/**
 * confirmationHandler — procesa las respuestas al recordatorio nocturno.
 *
 * Los botones del recordatorio llevan el UUID de la cita en el payload
 * (reminder_confirm_{id} / reminder_cancel_{id}), así que la respuesta se
 * resuelve sin estado conversacional: la paciente puede contestar a las 6 AM
 * siguientes y el bot sabe exactamente de qué cita habla. messageHandler
 * rutea estos payloads aquí ANTES que cualquier flujo activo.
 *
 * También cubre el fallback de texto libre: si una paciente con recordatorio
 * pendiente contesta "sí" / "confirmo" en lugar de tocar el botón, se toma
 * como confirmación (tryHandleTextReply, llamado por messageHandler en IDLE).
 */

import { logger } from '../lib/logger.js';
import { samePhone } from '../lib/phones.js';
import { messages } from '../data/messages.js';
import * as appointmentRepository from '../services/appointmentRepository.js';
import * as notificationService from '../services/notificationService.js';
import { cancelAppointment } from '../services/appointmentLifecycle.js';
import { classifyConfirmation } from '../services/classifier.js';
import { sendMessage } from '../services/whatsappClient.js';
import { buildTextMessage } from '../services/messageBuilder.js';

const log = logger.child({ module: 'confirmationHandler' });

const REMINDER_PAYLOAD_RE = /^reminder_(confirm|cancel)_(.+)$/;

/**
 * ¿El mensaje es una respuesta de botón a un recordatorio?
 *
 * @param {object} message  Mensaje normalizado del webhook
 * @returns {{ action: 'confirm' | 'cancel', appointmentId: string } | null}
 */
export function parseReminderReply(message) {
  const structuredId = message.buttonPayload ?? message.listId;
  const match = structuredId ? REMINDER_PAYLOAD_RE.exec(structuredId) : null;
  if (!match) return null;
  return { action: match[1], appointmentId: match[2] };
}

/**
 * Procesa la respuesta de botón al recordatorio (confirm o cancel).
 *
 * @param {object} message  Mensaje normalizado
 * @param {{ action: string, appointmentId: string }} reply  De parseReminderReply
 */
export async function handleReminderReply(message, reply) {
  const from = message.from;
  const appointment = await appointmentRepository.getById(reply.appointmentId);

  if (!appointment || !samePhone(appointment.patientPhone, from)) {
    log.warn(
      { from, appointmentId: reply.appointmentId, found: Boolean(appointment) },
      'Respuesta a recordatorio sin cita válida para esta paciente',
    );
    return sendMessage(buildTextMessage(from, messages.reminder.notFound));
  }

  if (reply.action === 'confirm') {
    return confirmAppointment(from, appointment);
  }
  return cancelFromReminder(from, appointment);
}

/**
 * Fallback de texto libre en IDLE: "sí" / "confirmo" de una paciente con
 * recordatorio pendiente cuenta como confirmación de esa cita.
 *
 * @param {object} message  Mensaje normalizado (inputType text)
 * @returns {Promise<boolean>}  true si el mensaje se consumió aquí
 */
export async function tryHandleTextReply(message) {
  if (message.inputType !== 'text') return false;
  if (classifyConfirmation(message) !== 'yes') return false;

  const appointment = await appointmentRepository.getPendingRemindedByPhone(message.from);
  if (!appointment) return false;

  await confirmAppointment(message.from, appointment);
  return true;
}

// ─── Acciones ────────────────────────────────────────────────────────────────

async function confirmAppointment(from, appointment) {
  // Botón repetido o cita ya resuelta (cancelada/reagendada/completada):
  // no tocar nada, avisar suave.
  if (appointment.status !== 'pending') {
    const text = appointment.status === 'confirmed'
      ? messages.reminder.confirmedReply
      : messages.reminder.alreadyHandled;
    return sendMessage(buildTextMessage(from, text));
  }

  await appointmentRepository.markConfirmed(appointment.id);
  log.info({ appointmentId: appointment.id, from }, 'Cita confirmada por la paciente');

  await sendMessage(buildTextMessage(from, messages.reminder.confirmedReply));
  return notificationService.notifyConfirmation(appointment);
}

async function cancelFromReminder(from, appointment) {
  if (appointment.status !== 'pending' && appointment.status !== 'confirmed') {
    return sendMessage(buildTextMessage(from, messages.reminder.alreadyHandled));
  }

  await cancelAppointment(appointment);
  return sendMessage(buildTextMessage(from, messages.reminder.cancelledReply));
}

