/**
 * appointmentFlow — state machine del flujo de agendar cita.
 *
 * Estados:
 *   SELECTING_TYPE → SELECTING_LOCATION → [SHOWING_LOCATION_INFO] →
 *   SELECTING_DATE → SELECTING_TIME → COLLECTING_NAME → COLLECTING_NOTES
 *   → CONFIRMING → (fin)
 *
 * SHOWING_LOCATION_INFO solo aparece la primera vez que la paciente agenda en
 * un consultorio con firstVisitInfo (indicaciones de llegada de la doctora).
 *
 * El estado vive en MySQL (stateManager, tabla conversations) y sobrevive
 * reinicios. El contexto acumulado viaja en context_data:
 *   {
 *     type, typeLabel, durationMin,          // desde SELECTING_TYPE
 *     location,                              // desde SELECTING_LOCATION
 *     offeredDates: [{ date, label, shortLabel }],
 *     date, dateLabel,                       // desde SELECTING_DATE
 *     offeredSlots: ['09:00', ...],
 *     time,                                  // desde SELECTING_TIME
 *     name,                                  // desde COLLECTING_NAME
 *     notes,                                 // desde COLLECTING_NOTES (null si no hay)
 *   }
 *
 * Los comandos globales (cancelar / atrás / ayuda) los intercepta
 * messageHandler ANTES de llamar aquí; este módulo solo recibe input "normal".
 *
 * Input inválido en cualquier estado: mensaje de error suave + re-envío del
 * menú del paso, y se refresca el TTL de la conversación (touchState).
 */

import crypto from 'node:crypto';
import consultationTypes from '../data/consultationTypes.json' with { type: 'json' };
import { locationFirstVisitInfo, locationFullLabel } from '../data/locations.js';
import { logger } from '../lib/logger.js';
import { messages } from '../data/messages.js';
import * as stateManager from '../services/stateManager.js';
import * as appointmentRepository from '../services/appointmentRepository.js';
import * as patientRepository from '../services/patientRepository.js';
import * as calendarService from '../services/calendarService.js';
import * as notificationService from '../services/notificationService.js';
import * as waitlistService from '../services/waitlistService.js';
import { sendMessage } from '../services/whatsappClient.js';
import {
  buildTextMessage,
  buildTypeSelectionMessage,
  buildLocationSelectionMessage,
  buildLocationInfoMessage,
  buildWaitlistInviteMessage,
  buildDateSelectionMessage,
  buildTimeSelectionMessage,
  buildConfirmationMessage,
  slotPageView,
} from '../services/messageBuilder.js';
import {
  classifyTypeSelection,
  classifyLocationSelection,
  classifyLocationInfoContinue,
  classifyDateSelection,
  classifyTimeSelection,
  classifyShowMoreSlots,
  classifyName,
  classifyNotes,
  classifyConfirmation,
} from '../services/classifier.js';
import {
  getAvailableDates,
  getAvailableSlots,
  isSlotFree,
  slotToUtc,
  SEARCH_DAYS,
} from '../services/availabilityService.js';
import { addMinutes } from '../lib/dates.js';

const log = logger.child({ module: 'appointmentFlow' });

export const FLOW_TYPE = 'appointment';

export const STEPS = {
  SELECTING_TYPE: 'SELECTING_TYPE',
  SELECTING_LOCATION: 'SELECTING_LOCATION',
  SHOWING_LOCATION_INFO: 'SHOWING_LOCATION_INFO',
  SELECTING_DATE: 'SELECTING_DATE',
  SELECTING_TIME: 'SELECTING_TIME',
  COLLECTING_NAME: 'COLLECTING_NAME',
  COLLECTING_NOTES: 'COLLECTING_NOTES',
  CONFIRMING: 'CONFIRMING',
};

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Arranca (o reinicia) el flujo de agendado para una paciente.
 *
 * @param {string} from  wa_id de la paciente
 */
export async function start(from) {
  await setStep(from, STEPS.SELECTING_TYPE, {});
  await sendMessage(buildTypeSelectionMessage(from));
}

/**
 * Procesa un mensaje dentro del flujo activo.
 *
 * @param {{ currentStep: string, contextData: object | null }} state  De stateManager.getState
 * @param {object} message  Mensaje normalizado del webhook
 */
export async function handle(state, message) {
  const from = message.from;
  const ctx = state.contextData ?? {};

  switch (state.currentStep) {
    case STEPS.SELECTING_TYPE: return handleTypeSelection(from, ctx, message);
    case STEPS.SELECTING_LOCATION: return handleLocationSelection(from, ctx, message);
    case STEPS.SHOWING_LOCATION_INFO: return handleLocationInfo(from, ctx, message);
    case STEPS.SELECTING_DATE: return handleDateSelection(from, ctx, message);
    case STEPS.SELECTING_TIME: return handleTimeSelection(from, ctx, message);
    case STEPS.COLLECTING_NAME: return handleName(from, ctx, message);
    case STEPS.COLLECTING_NOTES: return handleNotes(from, ctx, message);
    case STEPS.CONFIRMING: return handleConfirmation(from, ctx, message);
    default:
      // Estado desconocido en DB (ej. residuo de una versión anterior del
      // código): reset defensivo en lugar de dejar a la paciente atorada.
      log.warn({ from, step: state.currentStep }, 'Paso desconocido — reiniciando flujo');
      return start(from);
  }
}

/**
 * Comando "atrás": regresa un paso y re-envía el menú correspondiente.
 * Las opciones dependientes de disponibilidad (fechas/horarios) se recalculan
 * porque pudieron cambiar desde que se ofrecieron.
 *
 * @param {{ currentStep: string, contextData: object | null }} state
 * @param {object} message
 */
export async function goBack(state, message) {
  const from = message.from;
  const ctx = state.contextData ?? {};

  switch (state.currentStep) {
    case STEPS.SELECTING_TYPE:
      // Primer paso: no hay a dónde regresar, re-mostramos el menú.
      await stateManager.touchState(from);
      return sendMessage(buildTypeSelectionMessage(from));
    case STEPS.SELECTING_LOCATION:
      return start(from);
    case STEPS.SHOWING_LOCATION_INFO:
    case STEPS.SELECTING_DATE:
      await setStep(from, STEPS.SELECTING_LOCATION, pick(ctx, ['type', 'typeLabel', 'durationMin']));
      return sendMessage(buildLocationSelectionMessage(from));
    case STEPS.SELECTING_TIME:
      return offerDates(from, ctx);
    case STEPS.COLLECTING_NAME:
      return offerSlots(from, ctx, ctx.date, ctx.dateLabel);
    case STEPS.COLLECTING_NOTES:
      await setStep(from, STEPS.COLLECTING_NAME, ctx);
      return sendMessage(buildTextMessage(from, messages.appointment.collectName));
    case STEPS.CONFIRMING:
      await setStep(from, STEPS.COLLECTING_NOTES, ctx);
      return sendMessage(buildTextMessage(from, messages.appointment.collectNotes));
    default:
      return start(from);
  }
}

// ─── Handlers por estado ─────────────────────────────────────────────────────

async function handleTypeSelection(from, ctx, message) {
  const typeKey = classifyTypeSelection(message);
  if (!typeKey) {
    return rejectInput(from, messages.appointment.selectTypeFallback, buildTypeSelectionMessage(from));
  }

  const typeDef = consultationTypes[typeKey];
  await setStep(from, STEPS.SELECTING_LOCATION, {
    ...ctx,
    type: typeKey,
    typeLabel: typeDef.label,
    durationMin: typeDef.durationMin,
  });
  return sendMessage(buildLocationSelectionMessage(from));
}

async function handleLocationSelection(from, ctx, message) {
  const location = classifyLocationSelection(message);
  if (!location) {
    return rejectInput(from, messages.appointment.invalidOption, buildLocationSelectionMessage(from));
  }

  // Primera vez agendando en este consultorio (cualquier status cuenta —
  // incluso una cita cancelada implica que ya recibió estas indicaciones):
  // mandar el mensaje de llegada de la doctora y esperar el "continuar".
  const info = locationFirstVisitInfo(location);
  if (info && !(await appointmentRepository.hasAnyAtLocation(from, location))) {
    await setStep(from, STEPS.SHOWING_LOCATION_INFO, { ...ctx, location });
    return sendMessage(buildLocationInfoMessage(from, info));
  }

  return offerDates(from, { ...ctx, location });
}

async function handleLocationInfo(from, ctx, message) {
  if (!classifyLocationInfoContinue(message)) {
    await stateManager.touchState(from);
    return sendMessage(buildTextMessage(from, messages.appointment.locationInfoContinue));
  }
  return offerDates(from, ctx);
}

async function handleDateSelection(from, ctx, message) {
  const date = classifyDateSelection(message, ctx.offeredDates);
  if (!date) {
    return rejectInput(from, messages.appointment.invalidOption, dateMenuFromContext(from, ctx));
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
    await setStep(from, STEPS.SELECTING_TIME, { ...ctx, slotPage: nextPage });
    return sendMessage(buildTimeSelectionMessage(from, ctx.date, ctx.dateLabel, ctx.offeredSlots, nextPage));
  }

  const { visible } = slotPageView(ctx.offeredSlots, page);
  const time = classifyTimeSelection(message, ctx.offeredSlots, visible);
  if (!time) {
    return rejectInput(
      from,
      messages.appointment.invalidOption,
      buildTimeSelectionMessage(from, ctx.date, ctx.dateLabel, ctx.offeredSlots, page),
    );
  }

  await setStep(from, STEPS.COLLECTING_NAME, { ...ctx, time });
  return sendMessage(buildTextMessage(from, messages.appointment.collectName));
}

async function handleName(from, ctx, message) {
  const name = classifyName(message);
  if (!name) {
    await stateManager.touchState(from);
    return sendMessage(buildTextMessage(from, messages.appointment.nameInvalid));
  }

  await setStep(from, STEPS.COLLECTING_NOTES, { ...ctx, name });
  return sendMessage(buildTextMessage(from, messages.appointment.collectNotes));
}

async function handleNotes(from, ctx, message) {
  const result = classifyNotes(message);
  if (!result) {
    await stateManager.touchState(from);
    return sendMessage(buildTextMessage(from, messages.appointment.collectNotes));
  }

  const newCtx = { ...ctx, notes: result.notes };
  await setStep(from, STEPS.CONFIRMING, newCtx);
  return sendMessage(buildConfirmationMessage(from, {
    typeLabel: newCtx.typeLabel,
    locationLabel: locationFullLabel(newCtx.location),
    dateLabel: newCtx.dateLabel,
    timeLabel: newCtx.time,
    name: newCtx.name,
    notes: newCtx.notes ?? undefined,
  }));
}

async function handleConfirmation(from, ctx, message) {
  const decision = classifyConfirmation(message);

  switch (decision) {
    case 'yes':
      return finalizeAppointment(from, ctx);
    case 'no':
      await stateManager.clearState(from);
      return sendMessage(buildTextMessage(from, messages.cancelled));
    case 'restart':
      return start(from);
    default:
      await stateManager.touchState(from);
      return sendMessage(buildTextMessage(from, messages.appointment.confirmFallback));
  }
}

// ─── Transiciones con recálculo de disponibilidad ────────────────────────────

/**
 * Calcula fechas disponibles y transiciona a SELECTING_DATE.
 * Si no hay ninguna en la ventana de búsqueda, termina el flujo con un
 * mensaje explicativo (TODO Fase 3: escalar a la doctora en vez de terminar).
 */
async function offerDates(from, ctx) {
  const dates = await getAvailableDates({
    location: ctx.location,
    durationMin: ctx.durationMin,
  });

  if (dates.length === 0) {
    log.warn({ from, location: ctx.location, durationMin: ctx.durationMin }, 'Sin fechas disponibles');
    await stateManager.clearState(from);
    return sendMessage(buildTextMessage(from, messages.appointment.noDatesAvailable({ days: SEARCH_DAYS })));
  }

  const offeredDates = dates.map(({ date, label, shortLabel }) => ({ date, label, shortLabel }));
  const newCtx = { ...ctx, offeredDates, date: undefined, dateLabel: undefined, offeredSlots: undefined };

  await setStep(from, STEPS.SELECTING_DATE, newCtx);
  return sendMessage(dateMenuFromContext(from, newCtx));
}

/**
 * Recalcula slots del día elegido y transiciona a SELECTING_TIME.
 * Si el día se llenó entre mensajes, avisa y re-ofrece fechas.
 */
async function offerSlots(from, ctx, date, dateLabel) {
  const slots = await getAvailableSlots({
    location: ctx.location,
    date,
    durationMin: ctx.durationMin,
  });

  if (slots.length === 0) {
    await sendMessage(buildTextMessage(from, messages.appointment.noTimesAvailable));
    return offerDates(from, ctx);
  }

  // Se guardan TODOS los slots del día; la presentación pagina de a 9 + "Ver
  // más horarios" cuando rebasan el límite de 10 items de WhatsApp.
  await setStep(from, STEPS.SELECTING_TIME, { ...ctx, date, dateLabel, offeredSlots: slots, slotPage: 0 });
  return sendMessage(buildTimeSelectionMessage(from, date, dateLabel, slots, 0));
}

// ─── Cierre del flujo ────────────────────────────────────────────────────────

/**
 * La paciente confirmó: última validación del slot, persistencia en MySQL,
 * evento en el calendario (CalDAV real desde Fase 2) y mensaje de confirmación.
 */
async function finalizeAppointment(from, ctx) {
  // Re-checar que el slot siga libre: otra paciente pudo ganarlo mientras
  // esta terminaba el flujo.
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
  const appointmentId = crypto.randomUUID();
  const appointment = {
    id: appointmentId,
    patientPhone: from,
    patientName: ctx.name,
    consultationType: ctx.type,
    location: ctx.location,
    scheduledAt,
    durationMin: ctx.durationMin,
    patientNotes: ctx.notes ?? null,
  };

  await patientRepository.upsertPatientInfo(from, ctx.name);
  await appointmentRepository.create(appointment);

  // El evento de calendario es secundario a la cita en DB: si falla, la cita
  // queda registrada y el evento se puede sincronizar después a mano.
  // TODO Fase 3: reconciliación automática de citas sin caldav_event_uid.
  if (calendarService.isConfigured()) {
    try {
      const { uid } = await calendarService.createEvent({
        summary: `Cita: ${ctx.name} (${ctx.typeLabel})`,
        start: scheduledAt,
        end: addMinutes(scheduledAt, ctx.durationMin),
        description: ctx.notes ?? undefined,
        location: ctx.location,
      });
      await appointmentRepository.attachCalDAVEvent(appointmentId, uid);
    } catch (err) {
      log.error({ err, appointmentId }, 'Cita creada en DB pero falló el evento de calendario');
    }
  } else {
    // Estado conocido (sin credenciales aún), no una falla: warn, no error.
    log.warn({ appointmentId }, 'Calendario sin configurar — cita sin evento de calendario');
  }

  await stateManager.clearState(from);

  log.info(
    { appointmentId, from, type: ctx.type, location: ctx.location, scheduledAt },
    'Cita agendada',
  );

  // Notificación a la doctora (toggle NOTIFY_NEW_APPOINTMENT + diferenciación
  // nueva/recurrente). Nunca lanza — es secundaria al flujo de la paciente.
  await notificationService.notifyNewAppointment(appointment);

  await sendMessage(buildTextMessage(from, messages.appointment.created({
    dateLabel: ctx.dateLabel,
    timeLabel: ctx.time,
    locationLabel: locationFullLabel(ctx.location),
  })));

  // Cita lejana: ofrecer la lista de espera (botones stateless con el UUID —
  // la paciente puede responder cuando quiera, sin estado conversacional).
  if (waitlistService.qualifiesForWaitlist(scheduledAt)) {
    return sendMessage(buildWaitlistInviteMessage(from, appointmentId, { dateLabel: ctx.dateLabel }));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function setStep(from, step, contextData) {
  await stateManager.setState(from, {
    currentStep: step,
    flowType: FLOW_TYPE,
    contextData,
  });
}

/** Input inválido: aviso suave + re-envío del menú del paso + TTL refrescado. */
async function rejectInput(from, fallbackText, menuPayload) {
  await stateManager.touchState(from);
  await sendMessage(buildTextMessage(from, fallbackText));
  return sendMessage(menuPayload);
}

/** El List Message de fechas usa la etiqueta corta (límite 24 chars por item). */
function dateMenuFromContext(from, ctx) {
  return buildDateSelectionMessage(
    from,
    ctx.offeredDates.map((d) => ({ date: d.date, label: d.shortLabel })),
  );
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}
