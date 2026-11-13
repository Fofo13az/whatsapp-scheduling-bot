/**
 * cancellationFlow — flujo de cancelación de una cita ya agendada.
 *
 * Estados:
 *   SELECTING_APPOINTMENT (solo si la paciente tiene varias citas activas)
 *   → CONFIRMING_CANCEL → (fin)
 *
 * Con una sola cita activa, el flujo arranca directo en la confirmación.
 * Al confirmar: appointmentLifecycle.cancelAppointment (MySQL + evento de
 * calendario + notificación a la doctora con toggle NOTIFY_CANCELLATION).
 *
 * Los comandos globales (cancelar / atrás / ayuda) los intercepta
 * messageHandler antes de llegar aquí. Ojo con la ambigüedad: "cancelar" como
 * comando global aborta ESTE flujo (no la cita) — comportamiento correcto:
 * nunca cancelamos una cita sin confirmación explícita.
 */

import { locationFullLabel, locationLabel } from '../data/locations.js';
import { logger } from '../lib/logger.js';
import { messages } from '../data/messages.js';
import * as stateManager from '../services/stateManager.js';
import * as appointmentRepository from '../services/appointmentRepository.js';
import { cancelAppointment } from '../services/appointmentLifecycle.js';
import { classifyAppointmentSelection, classifyCancelDecision } from '../services/classifier.js';
import { sendMessage } from '../services/whatsappClient.js';
import {
  buildTextMessage,
  buildCancelConfirmationMessage,
  buildAppointmentSelectionMessage,
} from '../services/messageBuilder.js';
import { formatLongDateEs, formatShortDateEs, getClinicParts } from '../lib/dates.js';

const log = logger.child({ module: 'cancellationFlow' });

export const FLOW_TYPE = 'cancellation';

export const STEPS = {
  SELECTING_APPOINTMENT: 'SELECTING_APPOINTMENT',
  CONFIRMING_CANCEL: 'CONFIRMING_CANCEL',
};

// Límite duro de items en un List Message. Una paciente con más de 10 citas
// activas no es un caso real de este consultorio.
const MAX_APPOINTMENT_OPTIONS = 10;

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Arranca el flujo: busca citas activas y decide el primer paso.
 *
 * @param {string} from  wa_id de la paciente
 */
export async function start(from) {
  const appointments = await appointmentRepository.getActiveByPhone(from);

  if (appointments.length === 0) {
    return sendMessage(buildTextMessage(from, messages.cancellation.noAppointmentsFound));
  }

  if (appointments.length === 1) {
    return offerConfirmation(from, {}, appointments[0]);
  }

  const offeredAppointments = appointments
    .slice(0, MAX_APPOINTMENT_OPTIONS)
    .map(appointmentOption);

  await setStep(from, STEPS.SELECTING_APPOINTMENT, { offeredAppointments });
  return sendMessage(buildAppointmentSelectionMessage(
    from,
    messages.cancellation.selectAppointment,
    offeredAppointments,
  ));
}

/**
 * Procesa un mensaje dentro del flujo activo.
 *
 * @param {{ currentStep: string, contextData: object | null }} state
 * @param {object} message  Mensaje normalizado del webhook
 */
export async function handle(state, message) {
  const from = message.from;
  const ctx = state.contextData ?? {};

  switch (state.currentStep) {
    case STEPS.SELECTING_APPOINTMENT: return handleAppointmentSelection(from, ctx, message);
    case STEPS.CONFIRMING_CANCEL: return handleCancelDecision(from, ctx, message);
    default:
      log.warn({ from, step: state.currentStep }, 'Paso desconocido — reiniciando flujo');
      await stateManager.clearState(from);
      return start(from);
  }
}

/**
 * Comando "atrás": del paso de confirmación regresa a la lista de citas
 * (recalculada — pudo cambiar); en el primer paso re-muestra el menú.
 *
 * @param {{ currentStep: string, contextData: object | null }} state
 * @param {object} message
 */
export async function goBack(state, message) {
  const from = message.from;
  await stateManager.clearState(from);
  return start(from);
}

// ─── Handlers por estado ─────────────────────────────────────────────────────

async function handleAppointmentSelection(from, ctx, message) {
  const appointmentId = classifyAppointmentSelection(message, ctx.offeredAppointments);
  if (!appointmentId) {
    await stateManager.touchState(from);
    await sendMessage(buildTextMessage(from, messages.appointment.invalidOption));
    return sendMessage(buildAppointmentSelectionMessage(
      from,
      messages.cancellation.selectAppointment,
      ctx.offeredAppointments,
    ));
  }

  const appointment = await appointmentRepository.getById(appointmentId);
  if (!appointment || !isActive(appointment)) {
    // La cita cambió entre mensajes (ej. la canceló desde el recordatorio):
    // recalcular desde cero.
    await stateManager.clearState(from);
    return start(from);
  }

  return offerConfirmation(from, ctx, appointment);
}

async function handleCancelDecision(from, ctx, message) {
  const decision = classifyCancelDecision(message, ctx.appointmentId);

  if (decision === 'no') {
    await stateManager.clearState(from);
    return sendMessage(buildTextMessage(from, messages.cancellation.kept));
  }

  if (decision !== 'yes') {
    await stateManager.touchState(from);
    return sendMessage(buildCancelConfirmationMessage(from, ctx.appointmentId, {
      dateLabel: ctx.dateLabel,
      timeLabel: ctx.timeLabel,
      locationLabel: ctx.locationLabel,
    }));
  }

  // Releer la cita: el estado conversacional pudo quedarse atrás de la DB.
  const appointment = await appointmentRepository.getById(ctx.appointmentId);
  await stateManager.clearState(from);

  if (!appointment || !isActive(appointment)) {
    return sendMessage(buildTextMessage(from, messages.reminder.alreadyHandled));
  }

  await cancelAppointment(appointment);
  log.info({ appointmentId: appointment.id, from }, 'Cita cancelada por la paciente (flujo)');
  return sendMessage(buildTextMessage(from, messages.cancellation.cancelled));
}

// ─── Internos ────────────────────────────────────────────────────────────────

async function offerConfirmation(from, ctx, appointment) {
  const labels = presentationLabels(appointment);

  await setStep(from, STEPS.CONFIRMING_CANCEL, {
    ...ctx,
    appointmentId: appointment.id,
    ...labels,
  });

  return sendMessage(buildCancelConfirmationMessage(from, appointment.id, labels));
}

async function setStep(from, step, contextData) {
  await stateManager.setState(from, {
    currentStep: step,
    flowType: FLOW_TYPE,
    contextData,
  });
}

function isActive(appointment) {
  return appointment.status === 'pending' || appointment.status === 'confirmed';
}

/** Item de List Message para una cita (label corto: límite 24 chars). */
function appointmentOption(appointment) {
  const scheduledAt = new Date(appointment.scheduledAt);
  return {
    id: appointment.id,
    shortLabel: formatShortDateEs(scheduledAt),
    timeLabel: timeHHMM(scheduledAt),
    locationLabel: locationLabel(appointment.location),
  };
}

function presentationLabels(appointment) {
  const scheduledAt = new Date(appointment.scheduledAt);
  return {
    dateLabel: formatLongDateEs(scheduledAt),
    timeLabel: timeHHMM(scheduledAt),
    locationLabel: locationFullLabel(appointment.location),
  };
}

function timeHHMM(date) {
  const parts = getClinicParts(date);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}
