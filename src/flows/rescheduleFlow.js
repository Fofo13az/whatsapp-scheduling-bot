/**
 * rescheduleFlow — flujo de reagendamiento automático.
 *
 * Estados:
 *   SELECTING_APPOINTMENT (solo si hay varias citas activas)
 *   → SELECTING_NEW_DATE → SELECTING_NEW_TIME → CONFIRMING_CHANGE → (fin)
 *
 * La cita nueva conserva tipo de consulta, consultorio, duración, nombre y
 * notas de la original — solo cambia fecha/hora. Al confirmar:
 *   1. Se crea la cita nueva en MySQL con rescheduledFromId (trazabilidad).
 *   2. La vieja pasa a status 'rescheduled'.
 *   3. Calendario: se borra el evento viejo y se crea el nuevo (secundario a
 *      la DB — si falla, se loggea y se reconcilia después).
 *   4. Notificación a la doctora (NOTIFY_RESCHEDULE).
 *
 * Si no hay fechas disponibles, se escala a la doctora (notificación sin
 * toggle) y la cita original queda intacta.
 */

import crypto from 'node:crypto';
import consultationTypes from '../data/consultationTypes.json' with { type: 'json' };
import { locationLabel } from '../data/locations.js';
import { logger } from '../lib/logger.js';
import { messages, buttonLabels } from '../data/messages.js';
import * as stateManager from '../services/stateManager.js';
import * as appointmentRepository from '../services/appointmentRepository.js';
import * as calendarService from '../services/calendarService.js';
import * as notificationService from '../services/notificationService.js';
import * as waitlistRepository from '../services/waitlistRepository.js';
import { removeCalendarEvent } from '../services/appointmentLifecycle.js';
import {
  classifyAppointmentSelection,
  classifyDateSelection,
  classifyTimeSelection,
  classifyShowMoreSlots,
  classifyConfirmation,
} from '../services/classifier.js';
import { sendMessage } from '../services/whatsappClient.js';
import {
  buildTextMessage,
  buildButtonsMessage,
  buildDateSelectionMessage,
  buildTimeSelectionMessage,
  buildAppointmentSelectionMessage,
  slotPageView,
} from '../services/messageBuilder.js';
import {
  getAvailableDates,
  getAvailableSlots,
  isSlotFree,
  slotToUtc,
} from '../services/availabilityService.js';
import { addMinutes, formatLongDateEs, formatShortDateEs, getClinicParts } from '../lib/dates.js';

const log = logger.child({ module: 'rescheduleFlow' });

export const FLOW_TYPE = 'reschedule';

export const STEPS = {
  SELECTING_APPOINTMENT: 'SELECTING_APPOINTMENT',
  SELECTING_NEW_DATE: 'SELECTING_NEW_DATE',
  SELECTING_NEW_TIME: 'SELECTING_NEW_TIME',
  CONFIRMING_CHANGE: 'CONFIRMING_CHANGE',
};

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
    return sendMessage(buildTextMessage(from, messages.reschedule.noAppointmentsFound));
  }

  if (appointments.length === 1) {
    return offerDates(from, {}, appointments[0]);
  }

  const offeredAppointments = appointments
    .slice(0, MAX_APPOINTMENT_OPTIONS)
    .map(appointmentOption);

  await setStep(from, STEPS.SELECTING_APPOINTMENT, { offeredAppointments });
  return sendMessage(buildAppointmentSelectionMessage(
    from,
    messages.reschedule.selectAppointment,
    offeredAppointments,
  ));
}

/**
 * Procesa un mensaje dentro del flujo activo.
 *
 * @param {{ currentStep: string, contextData: object | null }} state
 * @param {object} message
 */
export async function handle(state, message) {
  const from = message.from;
  const ctx = state.contextData ?? {};

  switch (state.currentStep) {
    case STEPS.SELECTING_APPOINTMENT: return handleAppointmentSelection(from, ctx, message);
    case STEPS.SELECTING_NEW_DATE: return handleDateSelection(from, ctx, message);
    case STEPS.SELECTING_NEW_TIME: return handleTimeSelection(from, ctx, message);
    case STEPS.CONFIRMING_CHANGE: return handleChangeConfirmation(from, ctx, message);
    default:
      log.warn({ from, step: state.currentStep }, 'Paso desconocido — reiniciando flujo');
      await stateManager.clearState(from);
      return start(from);
  }
}

/**
 * Comando "atrás": regresa un paso recalculando disponibilidad.
 *
 * @param {{ currentStep: string, contextData: object | null }} state
 * @param {object} message
 */
export async function goBack(state, message) {
  const from = message.from;
  const ctx = state.contextData ?? {};

  switch (state.currentStep) {
    case STEPS.SELECTING_NEW_TIME:
      return withActiveAppointment(from, ctx, (appointment) => offerDates(from, ctx, appointment));
    case STEPS.CONFIRMING_CHANGE:
      return offerSlots(from, ctx, ctx.date, ctx.dateLabel);
    default:
      // Primer paso (o selección de cita): reiniciar recalcula todo.
      await stateManager.clearState(from);
      return start(from);
  }
}

// ─── Handlers por estado ─────────────────────────────────────────────────────

async function handleAppointmentSelection(from, ctx, message) {
  const appointmentId = classifyAppointmentSelection(message, ctx.offeredAppointments);
  if (!appointmentId) {
    await stateManager.touchState(from);
    await sendMessage(buildTextMessage(from, messages.appointment.invalidOption));
    return sendMessage(buildAppointmentSelectionMessage(
      from,
      messages.reschedule.selectAppointment,
      ctx.offeredAppointments,
    ));
  }

  return withActiveAppointment(from, ctx, (appointment) => offerDates(from, ctx, appointment), appointmentId);
}

async function handleDateSelection(from, ctx, message) {
  const date = classifyDateSelection(message, ctx.offeredDates);
  if (!date) {
    await stateManager.touchState(from);
    await sendMessage(buildTextMessage(from, messages.appointment.invalidOption));
    return sendMessage(dateMenuFromContext(from, ctx));
  }

  const chosen = ctx.offeredDates.find((d) => d.date === date);
  return offerSlots(from, ctx, date, chosen.label);
}

async function handleTimeSelection(from, ctx, message) {
  const page = ctx.slotPage ?? 0;

  // "Ver más horarios": avanzar de página (y dar la vuelta al llegar al final).
  if (classifyShowMoreSlots(message)) {
    const view = slotPageView(ctx.offeredSlots, page);
    const nextPage = view.hasMore ? view.page + 1 : 0;
    await setStep(from, STEPS.SELECTING_NEW_TIME, { ...ctx, slotPage: nextPage });
    return sendMessage(buildTimeSelectionMessage(from, ctx.date, ctx.dateLabel, ctx.offeredSlots, nextPage));
  }

  const { visible } = slotPageView(ctx.offeredSlots, page);
  const time = classifyTimeSelection(message, ctx.offeredSlots, visible);
  if (!time) {
    await stateManager.touchState(from);
    await sendMessage(buildTextMessage(from, messages.appointment.invalidOption));
    return sendMessage(buildTimeSelectionMessage(from, ctx.date, ctx.dateLabel, ctx.offeredSlots, page));
  }

  const newCtx = { ...ctx, time };
  await setStep(from, STEPS.CONFIRMING_CHANGE, newCtx);
  return sendMessage(buildChangeConfirmationMessage(from, newCtx));
}

async function handleChangeConfirmation(from, ctx, message) {
  const decision = classifyConfirmation(message);

  switch (decision) {
    case 'yes':
      return finalizeReschedule(from, ctx);
    case 'no':
      await stateManager.clearState(from);
      return sendMessage(buildTextMessage(from, messages.cancellation.kept));
    case 'restart':
      await stateManager.clearState(from);
      return start(from);
    default:
      await stateManager.touchState(from);
      return sendMessage(buildChangeConfirmationMessage(from, ctx));
  }
}

// ─── Transiciones con recálculo de disponibilidad ────────────────────────────

/**
 * Ofrece fechas para la cita a mover. Si no hay disponibilidad: escala a la
 * doctora y termina el flujo (la cita original queda intacta).
 */
async function offerDates(from, ctx, appointment) {
  const dates = await getAvailableDates({
    location: appointment.location,
    durationMin: appointment.durationMin,
  });

  if (dates.length === 0) {
    log.warn({ from, appointmentId: appointment.id }, 'Sin fechas para reagendar — escalando a la doctora');
    await stateManager.clearState(from);
    await sendMessage(buildTextMessage(from, messages.reschedule.escalate));
    return notificationService.notifyRescheduleEscalation(appointment);
  }

  const oldLabels = presentationLabels(appointment);
  const offeredDates = dates.map(({ date, label, shortLabel }) => ({ date, label, shortLabel }));
  const newCtx = {
    appointmentId: appointment.id,
    oldDateLabel: oldLabels.dateLabel,
    oldTimeLabel: oldLabels.timeLabel,
    location: appointment.location,
    durationMin: appointment.durationMin,
    offeredAppointments: ctx.offeredAppointments,
    offeredDates,
    date: undefined,
    dateLabel: undefined,
    offeredSlots: undefined,
    time: undefined,
  };

  await setStep(from, STEPS.SELECTING_NEW_DATE, newCtx);
  await sendMessage(buildTextMessage(from, messages.reschedule.intro({
    dateLabel: oldLabels.dateLabel,
    timeLabel: oldLabels.timeLabel,
  })));
  return sendMessage(dateMenuFromContext(from, newCtx));
}

async function offerSlots(from, ctx, date, dateLabel) {
  const slots = await getAvailableSlots({
    location: ctx.location,
    date,
    durationMin: ctx.durationMin,
  });

  if (slots.length === 0) {
    await sendMessage(buildTextMessage(from, messages.appointment.noTimesAvailable));
    return withActiveAppointment(from, ctx, (appointment) => offerDates(from, ctx, appointment));
  }

  // Todos los slots del día; la presentación pagina (ver slotPageView).
  await setStep(from, STEPS.SELECTING_NEW_TIME, { ...ctx, date, dateLabel, offeredSlots: slots, slotPage: 0 });
  return sendMessage(buildTimeSelectionMessage(from, date, dateLabel, slots, 0));
}

// ─── Cierre del flujo ────────────────────────────────────────────────────────

async function finalizeReschedule(from, ctx) {
  // Releer la cita original: pudo cancelarse/moverse mientras conversábamos.
  const oldAppointment = await appointmentRepository.getById(ctx.appointmentId);
  if (!oldAppointment || !isActive(oldAppointment)) {
    await stateManager.clearState(from);
    return sendMessage(buildTextMessage(from, messages.reminder.alreadyHandled));
  }

  const stillFree = await isSlotFree({
    location: ctx.location,
    date: ctx.date,
    time: ctx.time,
    durationMin: ctx.durationMin,
  });

  if (!stillFree) {
    await sendMessage(buildTextMessage(from, messages.appointment.slotTaken));
    return offerSlots(from, ctx, ctx.date, ctx.dateLabel);
  }

  const scheduledAt = slotToUtc(ctx.date, ctx.time);
  const newId = crypto.randomUUID();

  // MySQL primero (fuente de verdad): crear la nueva y marcar la vieja.
  await appointmentRepository.create({
    id: newId,
    patientPhone: oldAppointment.patientPhone,
    patientName: oldAppointment.patientName,
    consultationType: oldAppointment.consultationType,
    location: oldAppointment.location,
    scheduledAt,
    durationMin: oldAppointment.durationMin,
    patientNotes: oldAppointment.patientNotes,
    rescheduledFromId: oldAppointment.id,
  });
  await appointmentRepository.markRescheduled(oldAppointment.id);
  // Si estaba en lista de espera, su entrada sigue a la cita nueva.
  await waitlistRepository.moveEntryToAppointment(oldAppointment.id, newId);

  // Calendario: borrar evento viejo, crear el nuevo. Secundario a la DB.
  await removeCalendarEvent(oldAppointment);
  if (calendarService.isConfigured()) {
    try {
      const typeLabel = consultationTypes[oldAppointment.consultationType]?.label
        ?? oldAppointment.consultationType;
      const { uid } = await calendarService.createEvent({
        summary: `Cita: ${oldAppointment.patientName} (${typeLabel})`,
        start: scheduledAt,
        end: addMinutes(scheduledAt, oldAppointment.durationMin),
        description: oldAppointment.patientNotes ?? undefined,
        location: oldAppointment.location,
      });
      await appointmentRepository.attachCalDAVEvent(newId, uid);
    } catch (err) {
      log.error({ err, appointmentId: newId }, 'Cita reagendada en DB pero falló el evento de calendario');
    }
  }

  await stateManager.clearState(from);

  const newAppointment = await appointmentRepository.getById(newId);
  log.info(
    { from, oldId: oldAppointment.id, newId, scheduledAt },
    'Cita reagendada',
  );

  await sendMessage(buildTextMessage(from, messages.reschedule.success({
    newLabel: `${ctx.dateLabel} a las ${ctx.time}`,
  })));
  return notificationService.notifyReschedule(oldAppointment, newAppointment);
}

// ─── Internos ────────────────────────────────────────────────────────────────

/**
 * Relee la cita en contexto y ejecuta la acción si sigue activa; si ya no
 * (cancelada/movida entre mensajes), reinicia el flujo desde cero.
 */
async function withActiveAppointment(from, ctx, action, appointmentId = ctx.appointmentId) {
  const appointment = await appointmentRepository.getById(appointmentId);
  if (!appointment || !isActive(appointment)) {
    await stateManager.clearState(from);
    return start(from);
  }
  return action(appointment);
}

function buildChangeConfirmationMessage(from, ctx) {
  const body = messages.reschedule.confirmChange({
    oldLabel: `${ctx.oldDateLabel}, ${ctx.oldTimeLabel}`,
    newLabel: `${ctx.dateLabel}, ${ctx.time}`,
  });

  return {
    ...buildButtonsMessage(from, body, [
      { id: 'confirm_yes', label: buttonLabels.confirm },
      { id: 'confirm_no', label: buttonLabels.cancel },
    ]),
    kind: 'reschedule_confirmation',
  };
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

function dateMenuFromContext(from, ctx) {
  return buildDateSelectionMessage(
    from,
    ctx.offeredDates.map((d) => ({ date: d.date, label: d.shortLabel })),
  );
}

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
  };
}

function timeHHMM(date) {
  const parts = getClinicParts(date);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}
