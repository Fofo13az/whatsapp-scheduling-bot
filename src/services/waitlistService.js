/**
 * waitlistService — orquestación de la lista de espera (requerimiento de la
 * doctora, 19/08/2026 — docs/Nueva actualizacion 19-08-26.md).
 *
 * Ciclo completo:
 *   1. Una paciente agenda una cita lejana (≥ WAITLIST_MIN_DAYS_AHEAD días)
 *      → appointmentFlow le ofrece unirse a la lista (botones stateless).
 *   2. Otra paciente cancela (o la doctora quita la cita de su calendario —
 *      calendarSync) → onSlotFreed: si hay candidatas con cita más lejana, se
 *      crea un slot_offer y se avisa a la doctora con botones "Ver lista de
 *      espera" / "Dejar libre".
 *   3. La doctora ve la lista COMPLETA en texto (actualización 23/09: un List
 *      Message solo admite 10 opciones y con 70+ pacientes se perdían) y
 *      elige escribiendo el nombre (o el número): recibe el detalle de esa
 *      paciente con botones "Ofrecerle horario" / "Dejar libre", o escribe
 *      otro nombre para ver a otra. Al ofrecer, la paciente recibe la oferta.
 *   4. La paciente acepta (su cita se mueve al hueco, con swap de calendario
 *      y aviso a la doctora) o rechaza (la doctora puede elegir a otra).
 *
 * A voluntad (revisión 25/09): la doctora escribe "lista de espera" y recibe
 * la lista completa sin que nadie haya cancelado; escribe un nombre, toca
 * "Buscarle horario", elige día y hora (de ambos consultorios, antes de la
 * cita de la paciente) y confirma. Eso crea un slot_offer sin cita de origen
 * y desde ahí el ciclo es idéntico al de un hueco liberado (pasos 3-4).
 *
 * La doctora decide SIEMPRE — no hay turnos automáticos. Las demás pacientes
 * de la lista nunca se enteran de a quién se le ofreció (privacidad del
 * requerimiento). El hueco NO se aparta: cualquier paciente puede ganarlo por
 * el flujo normal mientras la oferta viaja, así que cada paso re-valida con
 * isSlotFree (misma política optimista del resto del sistema).
 *
 * Todas las interacciones viajan con UUIDs en los payloads de los botones
 * (sin estado conversacional) porque doctora y paciente responden con horas
 * de diferencia — misma técnica que los recordatorios. La única excepción es
 * el nombre que escribe la doctora: se resuelve contra la oferta cuya lista
 * abrió en las últimas 24h (slot_offers.doctor_browsed_at) o, si no hay
 * ninguna, contra la lista completa.
 */

import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { samePhone } from '../lib/phones.js';
import { messages } from '../data/messages.js';
import { locationFullLabel, locationLabel } from '../data/locations.js';
import * as waitlistRepository from './waitlistRepository.js';
import * as appointmentRepository from './appointmentRepository.js';
import * as calendarService from './calendarService.js';
import * as notificationService from './notificationService.js';
// Import circular con appointmentLifecycle (que nos llama en onSlotFreed):
// inofensivo — ambos lados solo usan funciones en runtime, nunca al cargar.
import { removeCalendarEvent } from './appointmentLifecycle.js';
import {
  getAvailableDates,
  getAvailableSlots,
  getLocations,
  isSlotFree,
  slotToUtc,
} from './availabilityService.js';
import { classifyWaitlistPatient } from './classifier.js';
import { sendMessage, sendTemplate } from './whatsappClient.js';
import {
  buildLongTextMessages,
  buildTextMessage,
  buildWaitlistDateSelectionMessage,
  buildWaitlistGeneralDetailMessage,
  buildWaitlistManualConfirmMessage,
  buildWaitlistOfferMessage,
  buildWaitlistPatientDetailMessage,
  buildWaitlistTimeSelectionMessage,
} from './messageBuilder.js';
import consultationTypes from '../data/consultationTypes.json' with { type: 'json' };
import {
  addMinutes,
  formatDDMMYYYY,
  formatLongDateEs,
  formatShortDateEs,
  getClinicParts,
  MS_PER_MINUTE,
} from '../lib/dates.js';

const log = logger.child({ module: 'waitlistService' });

// Las notas de la paciente van dentro de un mensaje con botones (cuerpo máx.
// 1024 chars junto con el resto del detalle).
const DETAIL_NOTES_MAX_CHARS = 400;

// Días a ofrecer al buscarle horario a una paciente (límite de filas de un
// List Message de WhatsApp).
const MAX_DAY_OPTIONS = 10;

// ─── Invitación al agendar (paso 1) ──────────────────────────────────────────

/**
 * ¿La cita queda lo bastante lejos para ofrecer la lista de espera?
 *
 * @param {Date | string} scheduledAt
 * @param {Date} [now]
 * @returns {boolean}
 */
export function qualifiesForWaitlist(scheduledAt, now = new Date()) {
  const deltaMs = new Date(scheduledAt).getTime() - now.getTime();
  return deltaMs >= config.WAITLIST_MIN_DAYS_AHEAD * 24 * 60 * MS_PER_MINUTE;
}

/**
 * La paciente aceptó la invitación (botón wl_join_{appointmentId}).
 * Idempotente: tocar el botón dos veces no duplica.
 *
 * @param {string} from  wa_id de quien responde
 * @param {string} appointmentId
 */
export async function joinFromInvite(from, appointmentId) {
  const appointment = await appointmentRepository.getById(appointmentId);
  if (!appointment || !samePhone(appointment.patientPhone, from) || !isActive(appointment)) {
    log.warn({ from, appointmentId, found: Boolean(appointment) }, 'Invitación a waitlist sin cita válida');
    return sendMessage(buildTextMessage(from, messages.waitlist.inviteExpired));
  }

  await waitlistRepository.addEntry({ id: crypto.randomUUID(), appointmentId });
  log.info({ from, appointmentId }, 'Paciente agregada a la lista de espera');
  return sendMessage(buildTextMessage(from, messages.waitlist.joined));
}

/** La paciente declinó la invitación (botón wl_no_{appointmentId}). */
export async function declineInvite(from) {
  return sendMessage(buildTextMessage(from, messages.waitlist.inviteDeclined));
}

// ─── Hueco liberado (paso 2) ─────────────────────────────────────────────────

/**
 * Se liberó el horario de una cita (cancelación, o la doctora la quitó de su
 * calendario): si el hueco es futuro y hay candidatas en lista de espera con
 * cita más lejana, crea la oferta y avisa a la doctora. Nunca lanza — la
 * cancelación ya quedó registrada y esto es un extra.
 *
 * @param {object} cancelledAppointment  Forma de appointmentRepository
 * @param {{ headline?: string, now?: Date }} [options]  headline: primera
 *   línea del aviso (default: "X canceló y su horario quedó libre.")
 * @returns {Promise<boolean>}  true si se avisó a la doctora
 */
export async function onSlotFreed(cancelledAppointment, { headline, now = new Date() } = {}) {
  try {
    const scheduledAt = new Date(cancelledAppointment.scheduledAt);
    if (scheduledAt.getTime() <= now.getTime()) return false;

    const candidates = await waitlistRepository.getWaitingCandidates({ afterUtc: scheduledAt });
    if (candidates.length === 0) return false;

    const offer = {
      id: crypto.randomUUID(),
      sourceAppointmentId: cancelledAppointment.id,
      location: cancelledAppointment.location,
      scheduledAt,
      durationMin: cancelledAppointment.durationMin,
    };
    await waitlistRepository.createOffer(offer);

    await notificationService.notifyWaitlistPrompt(
      offer,
      headline ?? messages.doctor.waitlistFreedHeadline({ name: cancelledAppointment.patientName }),
      candidates.length,
    );
    log.info(
      { offerId: offer.id, sourceAppointmentId: cancelledAppointment.id, candidates: candidates.length },
      'Hueco liberado ofrecido a la doctora',
    );
    return true;
  } catch (err) {
    log.error({ err, appointmentId: cancelledAppointment.id }, 'Fallo procesando hueco liberado para waitlist');
    return false;
  }
}

// ─── Acciones de la doctora (paso 3) ─────────────────────────────────────────

/**
 * Botón "Ver lista de espera" (wl_view_{offerId}; en el template aprobado el
 * botón dice "Elegir paciente"): re-valida la oferta y manda la lista
 * COMPLETA de candidatas en texto, en orden cronológico de su cita. Su tap ya
 * abrió la ventana de 24h, así que esto puede ser mensaje de sesión aunque el
 * aviso original fuera template. Desde aquí, el texto que escriba la doctora
 * se interpreta como el nombre de una paciente (handleDoctorText).
 */
export async function doctorView(offerId) {
  const doctor = config.DOCTOR_PERSONAL_PHONE;
  const offer = await waitlistRepository.getOfferById(offerId);

  if (offer?.status === 'offered_patient') {
    const entry = await waitlistRepository.getEntryById(offer.offeredWaitlistId);
    return sendMessage(buildTextMessage(doctor, messages.doctor.waitlistOfferPendingPatient({
      name: entry?.patientName ?? 'la paciente',
    })));
  }

  const invalid = await invalidateStaleOffer(offer);
  if (invalid) return sendMessage(buildTextMessage(doctor, invalid));

  const candidates = await eligibleCandidates(offer);
  if (candidates.length === 0) {
    await waitlistRepository.closeOffer(offer.id);
    return sendMessage(buildTextMessage(doctor, messages.doctor.waitlistNoCandidates));
  }

  await waitlistRepository.markOfferBrowsed(offer.id);

  const { dateLabel, timeLabel } = slotLabels(offer.scheduledAt);
  const body = [
    messages.doctor.waitlistListHeader({
      dateLabel,
      timeLabel,
      locationLabel: locationLabel(offer.location),
      count: candidates.length,
    }),
    '',
    ...candidates.map((entry, i) => candidateLine(entry, i + 1)),
    '',
    messages.doctor.waitlistListFooter,
  ].join('\n');

  // Con decenas de pacientes puede rebasar el límite de un mensaje: se parte
  // entre líneas y se manda en orden.
  for (const payload of buildLongTextMessages(doctor, body)) {
    await sendMessage(payload);
  }
  log.info({ offerId, candidates: candidates.length }, 'Lista de espera enviada a la doctora');
}

/**
 * Texto libre de la doctora: si tiene abierta la lista de una oferta (la tocó
 * en las últimas 24h y sigue en sus manos), se interpreta como el nombre o
 * número de una paciente y se responde con su detalle y los botones para
 * ofrecerle el hueco. Si no hay lista abierta, no lo consume (sigue el ruteo
 * normal de messageHandler).
 *
 * @param {object} message  Mensaje normalizado (texto de la doctora)
 * @returns {Promise<boolean>}  true si el mensaje se consumió aquí
 */
export async function handleDoctorText(message) {
  if (message.inputType !== 'text' || !samePhone(message.from, config.DOCTOR_PERSONAL_PHONE)) {
    return false;
  }

  const offer = await waitlistRepository.getBrowsingOffer();
  if (!offer) return false;

  const doctor = config.DOCTOR_PERSONAL_PHONE;
  const invalid = await invalidateStaleOffer(offer);
  if (invalid) {
    await sendMessage(buildTextMessage(doctor, invalid));
    return true;
  }

  const candidates = await eligibleCandidates(offer);
  if (candidates.length === 0) {
    await waitlistRepository.closeOffer(offer.id);
    await sendMessage(buildTextMessage(doctor, messages.doctor.waitlistNoCandidates));
    return true;
  }

  // Cada mensaje suyo extiende la ventana de la lista abierta.
  await waitlistRepository.markOfferBrowsed(offer.id);

  const result = classifyWaitlistPatient(message, candidates);
  if (result.kind === 'match') {
    log.info({ offerId: offer.id, waitlistId: result.entry.id }, 'La doctora consultó el detalle de una paciente');
    await sendMessage(buildWaitlistPatientDetailMessage(
      doctor,
      offer.id,
      result.entry.id,
      patientDetailBody(offer, result.entry),
    ));
    return true;
  }

  if (result.kind === 'ambiguous') {
    const lines = result.entries
      .map((entry) => candidateLine(entry, candidates.indexOf(entry) + 1))
      .join('\n');
    await sendMessage(buildTextMessage(doctor, messages.doctor.waitlistNameAmbiguous({ lines })));
    return true;
  }

  await sendMessage(buildTextMessage(doctor, messages.doctor.waitlistNameNotFound({
    query: message.text.trim().slice(0, 60),
  })));
  return true;
}

/** Botón "Dejar libre" (wl_skip_{offerId}): cierra la oferta. */
export async function doctorSkip(offerId) {
  const doctor = config.DOCTOR_PERSONAL_PHONE;
  const offer = await waitlistRepository.getOfferById(offerId);

  if (!offer || offer.status === 'accepted' || offer.status === 'closed') {
    return sendMessage(buildTextMessage(doctor, messages.doctor.waitlistOfferInactive));
  }

  await waitlistRepository.closeOffer(offer.id);
  log.info({ offerId }, 'La doctora dejó el hueco libre');
  return sendMessage(buildTextMessage(doctor, messages.doctor.waitlistSkipped));
}

/**
 * La doctora eligió a una candidata (wl_pick_{offerId}_{waitlistId}):
 * re-valida hueco y candidata, marca la oferta y le escribe a la paciente.
 */
export async function doctorPick(offerId, waitlistId) {
  const doctor = config.DOCTOR_PERSONAL_PHONE;
  const offer = await waitlistRepository.getOfferById(offerId);

  if (offer?.status === 'offered_patient') {
    const pending = await waitlistRepository.getEntryById(offer.offeredWaitlistId);
    return sendMessage(buildTextMessage(doctor, messages.doctor.waitlistOfferPendingPatient({
      name: pending?.patientName ?? 'la paciente',
    })));
  }

  const invalid = await invalidateStaleOffer(offer);
  if (invalid) return sendMessage(buildTextMessage(doctor, invalid));

  const entry = await waitlistRepository.getEntryById(waitlistId);
  if (!isEligibleForOffer(entry, offer)) {
    // Su cita cambió entre el List Message y el tap: reofrecer la lista viva.
    await sendMessage(buildTextMessage(doctor, messages.appointment.invalidOption));
    return doctorView(offerId);
  }

  await waitlistRepository.markOfferedToPatient(offer.id, entry.id);
  try {
    const { messageId } = await sendOfferToPatient(offer, entry);
    // Si Meta no la entrega (status failed), statusHandler la regresa a la
    // doctora con este wamid.
    if (messageId) await waitlistRepository.setOfferMessageId(offer.id, messageId);
  } catch (err) {
    log.error({ err, offerId, waitlistId }, 'No se pudo enviar la oferta a la paciente');
    await waitlistRepository.revertOfferToDoctor(offer.id);
    return sendMessage(buildTextMessage(doctor, messages.doctor.waitlistSendFailed({ name: entry.patientName })));
  }

  log.info({ offerId, waitlistId, patientPhone: entry.patientPhone }, 'Oferta de hueco enviada a la paciente');
  return sendMessage(buildTextMessage(doctor, messages.doctor.waitlistOfferSent({ name: entry.patientName })));
}

// ─── Lista de espera a voluntad (revisión 25/09) ─────────────────────────────

/**
 * La doctora escribió "lista de espera": manda la lista COMPLETA (todas las
 * pacientes en espera con cita activa futura, de la cita más cercana a la más
 * lejana), sin depender de un hueco liberado.
 */
export async function doctorGeneralList() {
  const doctor = config.DOCTOR_PERSONAL_PHONE;

  // La última lista que abrió manda: su siguiente texto se busca en ésta y no
  // en la de un hueco liberado que tuviera abierta.
  await waitlistRepository.clearDoctorBrowsing();

  const entries = await waitlistRepository.getWaitingEntries();
  if (entries.length === 0) {
    return sendMessage(buildTextMessage(doctor, messages.doctor.waitlistGeneralEmpty));
  }

  const body = [
    messages.doctor.waitlistGeneralHeader({ count: entries.length }),
    '',
    ...entries.map((entry, i) => candidateLine(entry, i + 1)),
    '',
    messages.doctor.waitlistListFooter,
  ].join('\n');

  for (const payload of buildLongTextMessages(doctor, body)) {
    await sendMessage(payload);
  }
  log.info({ entries: entries.length }, 'Lista de espera completa enviada a la doctora');
}

/**
 * Texto de la doctora sin lista de hueco abierta que no es un intent
 * reconocido: se busca en la lista completa (nombre o número). Si no
 * encuentra a nadie, le explica cómo ver la lista en vez del "no entendí"
 * genérico. Lo llama messageHandler solo para la doctora.
 *
 * @param {object} message  Mensaje de texto normalizado
 */
export async function doctorGeneralLookup(message) {
  const doctor = config.DOCTOR_PERSONAL_PHONE;
  const entries = await waitlistRepository.getWaitingEntries();
  const result = classifyWaitlistPatient(message, entries);

  if (result.kind === 'match') {
    log.info({ waitlistId: result.entry.id }, 'La doctora consultó una paciente de la lista completa');
    return sendMessage(buildWaitlistGeneralDetailMessage(
      doctor,
      result.entry.id,
      messages.doctor.waitlistPatientDetailGeneral(patientInfo(result.entry)),
    ));
  }

  if (result.kind === 'ambiguous') {
    const lines = result.entries
      .map((entry) => candidateLine(entry, entries.indexOf(entry) + 1))
      .join('\n');
    return sendMessage(buildTextMessage(doctor, messages.doctor.waitlistNameAmbiguous({ lines })));
  }

  return sendMessage(buildTextMessage(doctor, messages.doctor.waitlistGeneralNameNotFound({
    query: message.text.trim().slice(0, 60),
  })));
}

/**
 * Botón "Buscarle horario" / "Otro horario" (wl_slots_{waitlistId}): días con
 * espacio ANTES de la cita de la paciente, de todos los consultorios.
 *
 * @param {string} waitlistId
 */
export async function doctorFindSlots(waitlistId) {
  const entry = await entryForManualOffer(waitlistId);
  if (!entry) return;
  return sendDayMenu(entry);
}

/**
 * La doctora eligió un día (wl_date_…) o pidió más horarios (wl_tpage_…):
 * horarios libres de ese día antes de la cita de la paciente.
 *
 * @param {string} waitlistId
 * @param {string} location  slug validado por waitlistHandler
 * @param {string} date      DD/MM/YYYY
 * @param {number} [page]
 */
export async function doctorPickDate(waitlistId, location, date, page = 0) {
  const entry = await entryForManualOffer(waitlistId);
  if (!entry) return;

  const slots = await earlierSlots(entry, location, date);
  if (slots.length === 0) {
    await sendMessage(buildTextMessage(config.DOCTOR_PERSONAL_PHONE, messages.doctor.waitlistDayFull));
    return sendDayMenu(entry);
  }
  return sendTimeMenu(entry, location, date, slots, page);
}

/**
 * La doctora eligió una hora (wl_time_…): confirmación antes de escribirle a
 * la paciente (es una paciente real — un tap equivocado no debe mandarle
 * nada).
 */
export async function doctorPickTime(waitlistId, location, date, time) {
  const entry = await entryForManualOffer(waitlistId);
  if (!entry) return;
  if (!(await manualSlotStillFree(entry, location, date, time))) return;

  const slot = slotLabels(slotToUtc(date, time));
  const current = slotLabels(entry.scheduledAt);
  return sendMessage(buildWaitlistManualConfirmMessage(
    config.DOCTOR_PERSONAL_PHONE,
    entry.id,
    location,
    date,
    time,
    messages.doctor.waitlistConfirmManualOffer({
      name: entry.patientName,
      slotLabel: `${slot.dateLabel}, ${slot.timeLabel}`,
      slotLocationLabel: locationLabel(location),
      appointmentLabel: `${current.dateLabel}, ${current.timeLabel}`,
      locationLabel: locationLabel(entry.location),
    }),
  ));
}

/**
 * "Sí, ofrecérselo" (wl_send_…): re-valida todo y convierte el horario en una
 * oferta — la de un hueco liberado aún sin asignar para ese mismo horario, o
 * una nueva sin cita de origen. De ahí en adelante es el ciclo normal:
 * doctorPick le escribe a la paciente y ella acepta o rechaza.
 */
export async function doctorSendManualOffer(waitlistId, location, date, time) {
  const doctor = config.DOCTOR_PERSONAL_PHONE;
  const entry = await entryForManualOffer(waitlistId);
  if (!entry) return;
  if (!(await manualSlotStillFree(entry, location, date, time))) return;

  const scheduledAt = slotToUtc(date, time);
  const existing = await waitlistRepository.getOpenOfferForSlot({ location, scheduledAt });

  // Nunca el mismo horario a dos pacientes a la vez.
  if (existing?.status === 'offered_patient') {
    const other = await waitlistRepository.getEntryById(existing.offeredWaitlistId);
    return sendMessage(buildTextMessage(doctor, messages.doctor.waitlistSlotOfferedToOther({
      name: other?.patientName ?? 'otra paciente',
    })));
  }

  let offerId;
  if (existing && !existing.declinedWaitlistIds.includes(entry.id)) {
    offerId = existing.id;
  } else {
    offerId = crypto.randomUUID();
    await waitlistRepository.createOffer({
      id: offerId,
      sourceAppointmentId: null,
      location,
      scheduledAt,
      durationMin: entry.durationMin,
    });
  }

  log.info(
    { offerId, waitlistId: entry.id, reused: offerId === existing?.id, location, scheduledAt },
    'La doctora ofrece un horario a voluntad',
  );
  return doctorPick(offerId, entry.id);
}

// ─── Respuesta de la paciente (paso 4) ───────────────────────────────────────

/**
 * La paciente aceptó el hueco (wloffer_accept_{offerId}): se mueve su cita
 * (misma mecánica que el reagendamiento: cita nueva con trazabilidad, la
 * vieja a 'rescheduled', swap de eventos de calendario, aviso a la doctora).
 */
export async function patientAccept(offerId, from) {
  const resolved = await resolvePatientReply(offerId, from);
  if (!resolved.ok) return sendMessage(buildTextMessage(from, resolved.reply));
  const { offer, entry } = resolved;

  // La cita ligada pudo cancelarse/moverse mientras la oferta viajaba.
  const oldAppointment = await appointmentRepository.getById(entry.appointmentId);
  if (!oldAppointment || !isActive(oldAppointment)) {
    await returnOfferToDoctor(offer, entry);
    return sendMessage(buildTextMessage(from, messages.waitlist.offerGone));
  }

  // El hueco no se apartó: pudo ganarlo otra paciente por el flujo normal.
  if (slotInPast(offer) || !(await offerSlotFree(offer, entry.durationMin))) {
    await waitlistRepository.closeOffer(offer.id);
    await sendMessage(buildTextMessage(from, messages.waitlist.offerGone));
    const { dateLabel, timeLabel } = slotLabels(offer.scheduledAt);
    return notificationService.notifyWaitlistNotice(messages.doctor.waitlistSlotGoneNotice({
      name: entry.patientName,
      dateLabel,
      timeLabel,
    }));
  }

  const scheduledAt = new Date(offer.scheduledAt);
  const newId = crypto.randomUUID();

  // MySQL primero (fuente de verdad), calendario después.
  await appointmentRepository.create({
    id: newId,
    patientPhone: oldAppointment.patientPhone,
    patientName: oldAppointment.patientName,
    consultationType: oldAppointment.consultationType,
    location: offer.location,
    scheduledAt,
    durationMin: oldAppointment.durationMin,
    patientNotes: oldAppointment.patientNotes,
    rescheduledFromId: oldAppointment.id,
  });
  await appointmentRepository.markRescheduled(oldAppointment.id);
  await waitlistRepository.markOfferAccepted(offer.id);
  await waitlistRepository.markEntryFulfilled(entry.id);

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
        location: offer.location,
      });
      await appointmentRepository.attachCalDAVEvent(newId, uid);
    } catch (err) {
      log.error({ err, appointmentId: newId }, 'Cita movida en DB pero falló el evento de calendario');
    }
  }

  const { dateLabel, timeLabel } = slotLabels(scheduledAt);
  log.info(
    { offerId, oldId: oldAppointment.id, newId, patientPhone: from },
    'Hueco de lista de espera aceptado — cita movida',
  );

  await sendMessage(buildTextMessage(from, messages.waitlist.offerAccepted({ dateLabel, timeLabel })));
  const newAppointment = await appointmentRepository.getById(newId);
  return notificationService.notifyReschedule(oldAppointment, newAppointment);
}

/**
 * La paciente rechazó el hueco (wloffer_decline_{offerId}): sigue en la
 * lista, y la doctora recibe de vuelta el aviso para elegir a otra.
 */
export async function patientDecline(offerId, from) {
  const resolved = await resolvePatientReply(offerId, from);
  if (!resolved.ok) return sendMessage(buildTextMessage(from, resolved.reply));
  const { offer, entry } = resolved;

  await sendMessage(buildTextMessage(from, messages.waitlist.offerDeclined));
  log.info({ offerId, waitlistId: entry.id }, 'La paciente rechazó el hueco ofrecido');
  return returnOfferToDoctor(offer, entry);
}

/**
 * Meta no entregó la oferta a la paciente (status failed — statusHandler):
 * la oferta regresa a la doctora como si la paciente la hubiera rechazado
 * (queda excluida de ESTE hueco: reenviársela fallaría igual). Sin esto, la
 * oferta se quedaría esperando una respuesta que nunca va a llegar.
 *
 * @param {object} offer  Forma de waitlistRepository
 */
export async function onOfferUndelivered(offer) {
  if (offer.status !== 'offered_patient') return; // ya se resolvió por otra vía

  const entry = await waitlistRepository.getEntryById(offer.offeredWaitlistId);
  if (!entry) {
    await waitlistRepository.revertOfferToDoctor(offer.id);
    return;
  }

  log.error(
    { offerId: offer.id, waitlistId: entry.id, patientPhone: entry.patientPhone },
    'Oferta de lista de espera NO entregada a la paciente — regresa a la doctora',
  );
  await returnOfferToDoctor(offer, entry, {
    headline: messages.doctor.waitlistOfferUndeliveredHeadline({ name: entry.patientName }),
    noMoreText: messages.doctor.waitlistOfferUndeliveredNoMore,
  });
}

// ─── Internos ────────────────────────────────────────────────────────────────

function isActive(appointment) {
  return appointment.status === 'pending' || appointment.status === 'confirmed';
}

function slotInPast(offer, now = new Date()) {
  return new Date(offer.scheduledAt).getTime() <= now.getTime();
}

/** Etiquetas y formatos del hueco en hora del consultorio. */
function slotLabels(scheduledAt) {
  const date = new Date(scheduledAt);
  const parts = getClinicParts(date);
  const timeLabel = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  return {
    dateLabel: formatLongDateEs(date),
    shortLabel: formatShortDateEs(date),
    timeLabel,
    date: formatDDMMYYYY(parts),
  };
}

/** ¿El hueco sigue libre según DB + calendario? */
async function offerSlotFree(offer, durationMin = offer.durationMin) {
  const { date, timeLabel } = slotLabels(offer.scheduledAt);
  return isSlotFree({ location: offer.location, date, time: timeLabel, durationMin });
}

/**
 * Valida una oferta en manos de la doctora. Devuelve el mensaje de rechazo
 * para ella (cerrando la oferta si aplica) o null si sigue viva.
 */
async function invalidateStaleOffer(offer) {
  if (!offer || offer.status !== 'pending_doctor') {
    return messages.doctor.waitlistOfferInactive;
  }
  if (slotInPast(offer)) {
    await waitlistRepository.closeOffer(offer.id);
    return messages.doctor.waitlistOfferInactive;
  }
  if (!(await offerSlotFree(offer))) {
    await waitlistRepository.closeOffer(offer.id);
    return messages.doctor.waitlistSlotTaken;
  }
  return null;
}

async function eligibleCandidates(offer) {
  return waitlistRepository.getWaitingCandidates({
    afterUtc: new Date(offer.scheduledAt),
    excludeIds: offer.declinedWaitlistIds,
  });
}

function isEligibleForOffer(entry, offer) {
  return Boolean(
    entry
    && entry.status === 'waiting'
    && (entry.appointmentStatus === 'pending' || entry.appointmentStatus === 'confirmed')
    && new Date(entry.scheduledAt).getTime() > new Date(offer.scheduledAt).getTime()
    && !offer.declinedWaitlistIds.includes(entry.id),
  );
}

/** Renglón de la lista en texto: "3. Paola Martínez — Mar 30 sep, 10:00 · Clínica Norte". */
function candidateLine(entry, index) {
  const { shortLabel, timeLabel } = slotLabels(entry.scheduledAt);
  return messages.doctor.waitlistListLine({
    index,
    name: entry.patientName,
    appointmentLabel: `${shortLabel}, ${timeLabel}`,
    locationLabel: locationLabel(entry.location),
  });
}

/** Datos de una paciente de la lista para los mensajes de detalle. */
function patientInfo(entry) {
  const appointment = slotLabels(entry.scheduledAt);
  return {
    name: entry.patientName,
    phone: entry.patientPhone,
    appointmentLabel: `${appointment.dateLabel}, ${appointment.timeLabel}`,
    locationLabel: locationLabel(entry.location),
    typeLabel: consultationTypes[entry.consultationType]?.label ?? entry.consultationType,
    notes: truncateText(entry.patientNotes, DETAIL_NOTES_MAX_CHARS),
    joinedLabel: formatLongDateEs(new Date(entry.createdAt)),
  };
}

/** Cuerpo del detalle de una candidata para un hueco (mensaje con botones). */
function patientDetailBody(offer, entry) {
  const slot = slotLabels(offer.scheduledAt);
  return messages.doctor.waitlistPatientDetail({
    ...patientInfo(entry),
    slotLabel: `${slot.dateLabel}, ${slot.timeLabel}`,
    slotLocationLabel: locationLabel(offer.location),
  });
}

/**
 * Relee la entrada para una acción a voluntad de la doctora. Si la paciente ya
 * no está en espera (cita cancelada, movida o pasada) o ya tiene una oferta
 * esperando su respuesta, se lo dice a la doctora y devuelve null.
 */
async function entryForManualOffer(waitlistId) {
  const doctor = config.DOCTOR_PERSONAL_PHONE;
  const entry = await waitlistRepository.getEntryById(waitlistId);
  if (
    !entry
    || entry.status !== 'waiting'
    || !(entry.appointmentStatus === 'pending' || entry.appointmentStatus === 'confirmed')
    || slotInPast(entry)
  ) {
    await sendMessage(buildTextMessage(doctor, messages.doctor.waitlistEntryInactive));
    return null;
  }

  const pending = await waitlistRepository.getPendingOfferForEntry(entry.id);
  if (pending) {
    const slot = slotLabels(pending.scheduledAt);
    await sendMessage(buildTextMessage(doctor, messages.doctor.waitlistAlreadyOffered({
      name: entry.patientName,
      slotLabel: `${slot.dateLabel}, ${slot.timeLabel}`,
    })));
    return null;
  }
  return entry;
}

/**
 * Días con espacio antes de la cita de la paciente en todos los consultorios,
 * en orden de fecha. Solo tiene sentido adelantar, no atrasar.
 */
async function earlierDays(entry) {
  const beforeUtc = new Date(entry.scheduledAt);
  const perLocation = await Promise.all(getLocations().map(async (location) => {
    const dates = await getAvailableDates({
      location,
      durationMin: entry.durationMin,
      maxDates: MAX_DAY_OPTIONS,
      beforeUtc,
    });
    return dates.map((d) => ({ location, ...d, firstSlotAt: slotToUtc(d.date, d.slots[0]) }));
  }));

  return perLocation
    .flat()
    .sort((a, b) => a.firstSlotAt - b.firstSlotAt)
    .slice(0, MAX_DAY_OPTIONS);
}

async function earlierSlots(entry, location, date) {
  return getAvailableSlots({
    location,
    date,
    durationMin: entry.durationMin,
    beforeUtc: new Date(entry.scheduledAt),
  });
}

async function sendDayMenu(entry) {
  const doctor = config.DOCTOR_PERSONAL_PHONE;
  const current = slotLabels(entry.scheduledAt);
  const appointmentLabel = `${current.dateLabel}, ${current.timeLabel}`;

  const days = await earlierDays(entry);
  if (days.length === 0) {
    return sendMessage(buildTextMessage(doctor, messages.doctor.waitlistNoEarlierDates({
      name: entry.patientName,
      appointmentLabel,
      phone: entry.patientPhone,
    })));
  }

  return sendMessage(buildWaitlistDateSelectionMessage(
    doctor,
    entry.id,
    messages.doctor.waitlistPickDate({
      name: entry.patientName,
      appointmentLabel,
      locationLabel: locationLabel(entry.location),
    }),
    days.map((d) => ({
      location: d.location,
      date: d.date,
      shortLabel: d.shortLabel,
      description: messages.doctor.waitlistDateRowDescription({
        locationLabel: locationLabel(d.location),
        count: d.slots.length,
      }),
    })),
  ));
}

async function sendTimeMenu(entry, location, date, slots, page) {
  return sendMessage(buildWaitlistTimeSelectionMessage(
    config.DOCTOR_PERSONAL_PHONE,
    entry.id,
    location,
    date,
    messages.doctor.waitlistPickTime({
      name: entry.patientName,
      dateLabel: slotLabels(slotToUtc(date, '12:00')).dateLabel,
      locationLabel: locationLabel(location),
    }),
    slots,
    page,
  ));
}

/**
 * ¿El horario elegido sigue siendo ofrecible? Futuro, antes de la cita de la
 * paciente y libre (DB + calendario). Si no, le avisa a la doctora y le
 * reenvía los horarios que quedan ese día (o los días, si ya no queda nada).
 */
async function manualSlotStillFree(entry, location, date, time) {
  const scheduledAt = slotToUtc(date, time);
  const usable = scheduledAt.getTime() > Date.now()
    && scheduledAt.getTime() < new Date(entry.scheduledAt).getTime()
    && (await isSlotFree({ location, date, time, durationMin: entry.durationMin }));
  if (usable) return true;

  await sendMessage(buildTextMessage(config.DOCTOR_PERSONAL_PHONE, messages.doctor.waitlistSlotNoLongerFree));
  const slots = await earlierSlots(entry, location, date);
  if (slots.length === 0) await sendDayMenu(entry);
  else await sendTimeMenu(entry, location, date, slots, 0);
  return false;
}

function truncateText(text, max) {
  if (!text) return null;
  const points = Array.from(text.trim());
  return points.length <= max ? points.join('') : `${points.slice(0, max - 1).join('')}…`;
}

/**
 * Envía la oferta del hueco a la paciente elegida: template si está
 * configurado (producción, fuera de su ventana de 24h) o mensaje de sesión.
 * Lanza si el envío falla — el caller revierte la oferta.
 *
 * @returns {Promise<{ messageId: string | null }>}  wamid asignado por Meta
 */
async function sendOfferToPatient(offer, entry) {
  const { dateLabel, timeLabel } = slotLabels(offer.scheduledAt);
  const oldDateLabel = formatLongDateEs(new Date(entry.scheduledAt));
  const params = {
    dateLabel,
    timeLabel,
    locationLabel: locationFullLabel(offer.location),
    oldDateLabel,
  };

  if (config.WAITLIST_OFFER_TEMPLATE_NAME) {
    return sendTemplate(entry.patientPhone, config.WAITLIST_OFFER_TEMPLATE_NAME, [
      {
        type: 'body',
        parameters: [
          entry.patientName,
          config.DOCTOR_NAME,
          dateLabel,
          timeLabel,
          params.locationLabel,
          oldDateLabel,
        ].map((text) => ({ type: 'text', text })),
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: `wloffer_accept_${offer.id}` }],
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '1',
        parameters: [{ type: 'payload', payload: `wloffer_decline_${offer.id}` }],
      },
    ]);
  }

  return sendMessage(buildWaitlistOfferMessage(entry.patientPhone, offer.id, params));
}

/**
 * Valida que la respuesta a una oferta venga de la paciente correcta y que la
 * oferta siga esperándola.
 *
 * @returns {Promise<{ ok: true, offer: object, entry: object } | { ok: false, reply: string }>}
 */
async function resolvePatientReply(offerId, from) {
  const offer = await waitlistRepository.getOfferById(offerId);
  if (!offer) return { ok: false, reply: messages.waitlist.offerGone };

  if (offer.status === 'accepted') {
    // Botón repetido tras aceptar: aviso suave, sin doble efecto.
    return { ok: false, reply: messages.reminder.alreadyHandled };
  }
  if (offer.status !== 'offered_patient') {
    return { ok: false, reply: messages.waitlist.offerGone };
  }

  const entry = await waitlistRepository.getEntryById(offer.offeredWaitlistId);
  if (!entry || !samePhone(entry.patientPhone, from)) {
    log.warn({ offerId, from }, 'Respuesta a oferta de waitlist de un número que no corresponde');
    return { ok: false, reply: messages.waitlist.offerGone };
  }

  return { ok: true, offer, entry };
}

/**
 * Regresa la oferta a la doctora tras un rechazo (o una candidata que dejó
 * de ser elegible, o una oferta que Meta no entregó): si quedan candidatas,
 * nuevo aviso con botones; si no, se cierra y se le avisa que el horario
 * queda libre.
 *
 * @param {object} offer
 * @param {object} entry  La candidata que ya no va (queda excluida del hueco)
 * @param {{ headline?: string, noMoreText?: Function }} [texts]
 */
async function returnOfferToDoctor(offer, entry, {
  headline = messages.doctor.waitlistDeclinedHeadline({ name: entry.patientName }),
  noMoreText = messages.doctor.waitlistNoMoreCandidates,
} = {}) {
  await waitlistRepository.markOfferDeclined(offer.id, entry.id);

  const remaining = await waitlistRepository.getWaitingCandidates({
    afterUtc: new Date(offer.scheduledAt),
    excludeIds: [...offer.declinedWaitlistIds, entry.id],
  });

  const { dateLabel, timeLabel } = slotLabels(offer.scheduledAt);
  if (remaining.length === 0) {
    await waitlistRepository.closeOffer(offer.id);
    return notificationService.notifyWaitlistNotice(noMoreText({
      name: entry.patientName,
      dateLabel,
      timeLabel,
    }));
  }

  return notificationService.notifyWaitlistPrompt(offer, headline, remaining.length);
}
