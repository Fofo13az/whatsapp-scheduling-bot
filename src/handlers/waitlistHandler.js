/**
 * waitlistHandler — rutea los payloads stateless de la lista de espera.
 *
 * Igual que las respuestas a recordatorios, estos botones llevan los UUIDs
 * necesarios en el payload y se resuelven sin estado conversacional (la
 * doctora y las pacientes responden horas después). messageHandler los rutea
 * aquí ANTES que cualquier flujo activo.
 *
 * Payloads:
 *   wl_join_{appointmentId} / wl_no_{appointmentId}   → paciente (invitación)
 *   wl_view_{offerId} / wl_skip_{offerId}             → doctora
 *   wl_pick_{offerId}_{waitlistId}                    → doctora
 *   wloffer_accept_{offerId} / wloffer_decline_{offerId} → paciente (oferta)
 *
 * A voluntad (revisión 25/09), todos de la doctora — {loc} es el slug del
 * consultorio, {date} DD/MM/YYYY y {time} HH:mm:
 *   wl_slots_{waitlistId}                        → días con espacio
 *   wl_date_{waitlistId}_{loc}_{date}            → horarios de ese día
 *   wl_tpage_{waitlistId}_{loc}_{date}_{page}    → siguiente página de horarios
 *   wl_time_{waitlistId}_{loc}_{date}_{time}     → confirmación
 *   wl_send_{waitlistId}_{loc}_{date}_{time}     → enviar la oferta
 *
 * Además, el TEXTO de la doctora: "lista de espera" (tryHandleDoctorCommand),
 * el nombre o número de una paciente con la lista de un hueco abierta
 * (tryHandleDoctorText) o, sin ella, buscado en la lista completa
 * (tryHandleDoctorLookup).
 */

import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { samePhone } from '../lib/phones.js';
import { LOCATION_KEYS } from '../data/locations.js';
import { isWaitlistCommand } from '../services/classifier.js';
import * as stateManager from '../services/stateManager.js';
import * as waitlistService from '../services/waitlistService.js';

const log = logger.child({ module: 'waitlistHandler' });

const UUID = '[0-9a-fA-F-]{36}';
const LOC = '([a-z_]+)';
const DATE = '(\\d{2}/\\d{2}/\\d{4})';
const TIME = '(\\d{2}:\\d{2})';

const PATTERNS = [
  { re: new RegExp(`^wl_join_(${UUID})$`), type: 'join', doctorOnly: false },
  { re: new RegExp(`^wl_no_(${UUID})$`), type: 'join_decline', doctorOnly: false },
  { re: new RegExp(`^wl_view_(${UUID})$`), type: 'doctor_view', doctorOnly: true },
  { re: new RegExp(`^wl_skip_(${UUID})$`), type: 'doctor_skip', doctorOnly: true },
  { re: new RegExp(`^wl_pick_(${UUID})_(${UUID})$`), type: 'doctor_pick', doctorOnly: true },
  { re: new RegExp(`^wloffer_accept_(${UUID})$`), type: 'offer_accept', doctorOnly: false },
  { re: new RegExp(`^wloffer_decline_(${UUID})$`), type: 'offer_decline', doctorOnly: false },
  { re: new RegExp(`^wl_slots_(${UUID})$`), type: 'doctor_find_slots', doctorOnly: true },
  { re: new RegExp(`^wl_date_(${UUID})_${LOC}_${DATE}$`), type: 'doctor_pick_date', doctorOnly: true },
  { re: new RegExp(`^wl_tpage_(${UUID})_${LOC}_${DATE}_(\\d{1,2})$`), type: 'doctor_time_page', doctorOnly: true },
  { re: new RegExp(`^wl_time_(${UUID})_${LOC}_${DATE}_${TIME}$`), type: 'doctor_pick_time', doctorOnly: true },
  { re: new RegExp(`^wl_send_(${UUID})_${LOC}_${DATE}_${TIME}$`), type: 'doctor_send_offer', doctorOnly: true },
];

// Tipos cuyo segundo ID es el slug de un consultorio.
const TYPES_WITH_LOCATION = new Set([
  'doctor_pick_date', 'doctor_time_page', 'doctor_pick_time', 'doctor_send_offer',
]);

/**
 * ¿El mensaje es una respuesta de botón/lista de la lista de espera?
 *
 * @param {object} message  Mensaje normalizado del webhook
 * @returns {{ type: string, doctorOnly: boolean, ids: string[] } | null}
 */
export function parseWaitlistReply(message) {
  const structuredId = message.buttonPayload ?? message.listId;
  if (!structuredId) return null;

  for (const { re, type, doctorOnly } of PATTERNS) {
    const match = re.exec(structuredId);
    if (match) return { type, doctorOnly, ids: match.slice(1) };
  }
  return null;
}

function isDoctorText(message) {
  return message.inputType === 'text' && samePhone(message.from, config.DOCTOR_PERSONAL_PHONE);
}

/**
 * "lista de espera" escrito por la doctora: la lista completa, a voluntad.
 * Es un comando explícito, así que le gana a cualquier flujo en el que
 * estuviera (se limpia).
 *
 * @param {object} message
 * @returns {Promise<boolean>}  true si el mensaje se consumió aquí
 */
export async function tryHandleDoctorCommand(message) {
  if (!isDoctorText(message) || !isWaitlistCommand(message.text)) return false;
  await stateManager.clearState(message.from);
  await waitlistService.doctorGeneralList();
  return true;
}

/**
 * Texto de la doctora que no es un intent reconocido y sin lista de hueco
 * abierta: se busca en la lista completa. Para la doctora siempre se consume
 * (si no hay coincidencia, le explica cómo ver la lista).
 *
 * @param {object} message
 * @returns {Promise<boolean>}  true si el mensaje se consumió aquí
 */
export async function tryHandleDoctorLookup(message) {
  if (!isDoctorText(message)) return false;
  await waitlistService.doctorGeneralLookup(message);
  return true;
}

/**
 * Texto libre de la doctora mientras tiene abierta la lista de espera de un
 * hueco. No consume el mensaje si no hay lista abierta.
 *
 * @param {object} message
 * @returns {Promise<boolean>}  true si el mensaje se consumió aquí
 */
export async function tryHandleDoctorText(message) {
  if (!isDoctorText(message)) return false;
  return waitlistService.handleDoctorText(message);
}

/**
 * Ejecuta la acción del payload. Las acciones de doctora exigen que el
 * remitente sea DOCTOR_PERSONAL_PHONE; las de paciente validan la propiedad
 * dentro del service (la cita/oferta debe pertenecer a quien responde).
 *
 * @param {object} message
 * @param {{ type: string, doctorOnly: boolean, ids: string[] }} reply
 */
export async function handleWaitlistReply(message, reply) {
  const from = message.from;

  if (reply.doctorOnly && !samePhone(from, config.DOCTOR_PERSONAL_PHONE)) {
    log.warn({ from, type: reply.type }, 'Payload de doctora desde un número que no es la doctora — ignorado');
    return;
  }
  if (TYPES_WITH_LOCATION.has(reply.type) && !LOCATION_KEYS.includes(reply.ids[1])) {
    log.warn({ type: reply.type, location: reply.ids[1] }, 'Payload de waitlist con consultorio desconocido — ignorado');
    return;
  }

  switch (reply.type) {
    case 'join': return waitlistService.joinFromInvite(from, reply.ids[0]);
    case 'join_decline': return waitlistService.declineInvite(from);
    case 'doctor_view': return waitlistService.doctorView(reply.ids[0]);
    case 'doctor_skip': return waitlistService.doctorSkip(reply.ids[0]);
    case 'doctor_pick': return waitlistService.doctorPick(reply.ids[0], reply.ids[1]);
    case 'offer_accept': return waitlistService.patientAccept(reply.ids[0], from);
    case 'offer_decline': return waitlistService.patientDecline(reply.ids[0], from);
    case 'doctor_find_slots': return waitlistService.doctorFindSlots(reply.ids[0]);
    case 'doctor_pick_date': return waitlistService.doctorPickDate(reply.ids[0], reply.ids[1], reply.ids[2]);
    case 'doctor_time_page':
      return waitlistService.doctorPickDate(reply.ids[0], reply.ids[1], reply.ids[2], Number(reply.ids[3]));
    case 'doctor_pick_time':
      return waitlistService.doctorPickTime(reply.ids[0], reply.ids[1], reply.ids[2], reply.ids[3]);
    case 'doctor_send_offer':
      return waitlistService.doctorSendManualOffer(reply.ids[0], reply.ids[1], reply.ids[2], reply.ids[3]);
    default:
      log.warn({ type: reply.type }, 'Tipo de payload de waitlist desconocido');
  }
}
