/**
 * messageHandler — router principal de mensajes entrantes.
 *
 * Responsabilidades:
 *   1. Dedupe por wamid (Meta reintenta webhooks; el mismo mensaje puede
 *      llegar más de una vez).
 *   2. Comandos globales (cancelar / atrás / ayuda) con prioridad sobre todo.
 *   3. Con flujo activo → delegar al flow correspondiente.
 *   4. Sin flujo activo → texto de la doctora con la lista de espera abierta
 *      (nombre de una paciente), o clasificar intent (agendar, saludo,
 *      cancelar...) y arrancar lo que toque. El comando "lista de espera" de
 *      la doctora le gana incluso a un flujo activo.
 *   5. Red de seguridad: cualquier excepción se loggea y la paciente recibe
 *      el mensaje genérico de error — nunca un stack trace, nunca silencio.
 */

import { logger } from '../lib/logger.js';
import { messages } from '../data/messages.js';
import * as stateManager from '../services/stateManager.js';
import * as appointmentFlow from '../flows/appointmentFlow.js';
import * as cancellationFlow from '../flows/cancellationFlow.js';
import * as rescheduleFlow from '../flows/rescheduleFlow.js';
import * as confirmationHandler from './confirmationHandler.js';
import * as waitlistHandler from './waitlistHandler.js';
import * as notificationService from '../services/notificationService.js';
import { matchGlobalCommand, classifyIdleIntent } from '../services/classifier.js';
import { sendMessage } from '../services/whatsappClient.js';
import { buildTextMessage } from '../services/messageBuilder.js';

// Registro de flujos por flowType (columna flow_type de conversations).
const FLOWS = {
  [appointmentFlow.FLOW_TYPE]: appointmentFlow,
  [cancellationFlow.FLOW_TYPE]: cancellationFlow,
  [rescheduleFlow.FLOW_TYPE]: rescheduleFlow,
};

const log = logger.child({ module: 'messageHandler' });

// ─── Dedupe por wamid ────────────────────────────────────────────────────────
// En memoria: suficiente para una sola instancia (Railway corre una). Los
// reintentos de Meta llegan en una ventana corta; 10 min de TTL sobran. Si
// algún día hay múltiples instancias, mover a la DB.

const DEDUPE_TTL_MS = 10 * 60 * 1000;
const processedMessageIds = new Map(); // wamid → timestamp de procesamiento

function isDuplicate(wamid) {
  const now = Date.now();

  // Poda: los Map iteran en orden de inserción (cronológico aquí), así que
  // podemos parar en la primera entrada aún vigente.
  for (const [id, ts] of processedMessageIds) {
    if (now - ts <= DEDUPE_TTL_MS) break;
    processedMessageIds.delete(id);
  }

  if (processedMessageIds.has(wamid)) return true;
  processedMessageIds.set(wamid, now);
  return false;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Procesa un mensaje entrante normalizado por el webhook. Nunca lanza:
 * los errores se loggean y la paciente recibe el mensaje genérico.
 *
 * @param {object} message  Estructura uniforme de whatsappWebhook.normalizeMessage
 */
export async function handleIncomingMessage(message) {
  try {
    await routeMessage(message);
  } catch (err) {
    log.error({ err, from: message.from, inputType: message.inputType }, 'Error procesando mensaje entrante');
    // Alerta a la doctora (con throttle interno; nunca lanza).
    await notificationService.notifySystemError('mensajes de pacientes');
    try {
      await sendMessage(buildTextMessage(message.from, messages.error));
    } catch (sendErr) {
      log.error({ err: sendErr, from: message.from }, 'Tampoco se pudo enviar el mensaje de error');
    }
  }
}

async function routeMessage(message) {
  if (!message.from) {
    log.warn({ message }, 'Mensaje sin remitente — ignorado');
    return;
  }

  if (message.messageId && isDuplicate(message.messageId)) {
    log.info({ wamid: message.messageId, from: message.from }, 'Mensaje duplicado (reintento de Meta) — ignorado');
    return;
  }

  if (message.inputType === 'unsupported') {
    log.info({ from: message.from, rawType: message.rawType }, 'Tipo de mensaje no soportado');
    await sendMessage(buildTextMessage(message.from, messages.unsupportedType));
    return;
  }

  // Respuestas a recordatorios: prioridad sobre cualquier flujo activo. El
  // payload trae el UUID de la cita, así que se resuelven sin estado — y una
  // paciente puede tocar el botón del recordatorio a media conversación.
  const reminderReply = confirmationHandler.parseReminderReply(message);
  if (reminderReply) {
    return confirmationHandler.handleReminderReply(message, reminderReply);
  }

  // Botones de la lista de espera (invitación, elección de la doctora,
  // oferta a la paciente): misma técnica stateless que los recordatorios.
  const waitlistReply = waitlistHandler.parseWaitlistReply(message);
  if (waitlistReply) {
    return waitlistHandler.handleWaitlistReply(message, waitlistReply);
  }

  // "lista de espera" de la doctora: comando explícito, antes que cualquier
  // flujo (revisión 25/09).
  if (await waitlistHandler.tryHandleDoctorCommand(message)) return;

  const state = await stateManager.getState(message.from);
  const command = message.inputType === 'text' ? matchGlobalCommand(message.text) : null;

  if (state) {
    return routeWithActiveFlow(state, message, command);
  }

  // La doctora con la lista de espera abierta: su texto es el nombre (o
  // número) de una paciente. Un flujo activo (ej. ella probando agendar) y los
  // comandos globales tienen prioridad.
  if (!command && await waitlistHandler.tryHandleDoctorText(message)) return;

  return routeIdle(message, command);
}

// ─── Con flujo activo ────────────────────────────────────────────────────────

async function routeWithActiveFlow(state, message, command) {
  const from = message.from;
  const flow = FLOWS[state.flowType];

  // flowType desconocido (residuo de una versión anterior): reset defensivo
  // para no dejar a la paciente atorada en un flujo muerto.
  if (!flow) {
    log.warn({ from, flowType: state.flowType }, 'flowType sin handler — limpiando estado');
    await stateManager.clearState(from);
    return sendMessage(buildTextMessage(from, messages.unknown));
  }

  // Comandos globales: siempre le ganan al paso actual del flujo.
  if (command === 'cancel') {
    await stateManager.clearState(from);
    return sendMessage(buildTextMessage(from, messages.cancelled));
  }
  if (command === 'help') {
    await stateManager.touchState(from);
    return sendMessage(buildTextMessage(from, messages.help));
  }
  if (command === 'back') {
    return flow.goBack(state, message);
  }

  return flow.handle(state, message);
}

// ─── Sin flujo activo (IDLE) ─────────────────────────────────────────────────

async function routeIdle(message, command) {
  const from = message.from;

  if (command === 'help') {
    return sendMessage(buildTextMessage(from, messages.help));
  }

  switch (classifyIdleIntent(message)) {
    case 'schedule':
      return appointmentFlow.start(from);
    case 'greeting':
      return sendMessage(buildTextMessage(from, messages.greeting()));
    case 'help':
      return sendMessage(buildTextMessage(from, messages.help));
    case 'cancel_appointment':
      return cancellationFlow.start(from);
    case 'reschedule':
      return rescheduleFlow.start(from);
    default:
      // Un "sí" suelto de una paciente con recordatorio pendiente cuenta como
      // confirmación de esa cita (fallback de texto libre al botón).
      if (await confirmationHandler.tryHandleTextReply(message)) return;
      // La doctora escribiendo el nombre de una paciente de la lista completa.
      if (await waitlistHandler.tryHandleDoctorLookup(message)) return;
      return sendMessage(buildTextMessage(from, messages.unknown));
  }
}
