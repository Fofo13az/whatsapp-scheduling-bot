/**
 * waitlistRepository — CRUD de las tablas `waitlist` y `slot_offers`.
 *
 * La elegibilidad de una entrada de waitlist NO se materializa con updates:
 * se calcula al consultar (JOIN con appointments — la cita ligada debe seguir
 * activa y ser posterior al hueco liberado). Así, cancelar o completar la
 * cita saca a la paciente de la lista sin bookkeeping extra.
 */

import { pool } from '../db/connection.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'waitlistRepository' });

// ─── waitlist ────────────────────────────────────────────────────────────────

function rowToEntry(row) {
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    status: row.status,
    createdAt: row.created_at,
    // Presentes solo en las queries con JOIN a appointments:
    patientPhone: row.patient_phone,
    patientName: row.patient_name,
    consultationType: row.consultation_type,
    location: row.location,
    scheduledAt: row.scheduled_at,
    durationMin: row.duration_min,
    appointmentStatus: row.appointment_status,
    patientNotes: row.patient_notes,
  };
}

const ENTRY_JOIN_FIELDS = `
  w.id, w.appointment_id, w.status, w.created_at,
  a.patient_phone, a.patient_name, a.consultation_type, a.location,
  a.scheduled_at, a.duration_min, a.status AS appointment_status, a.patient_notes
`;

/**
 * Agrega una cita a la lista de espera. Idempotente: si la cita ya tiene
 * entrada (botón tocado dos veces), no duplica ni truena.
 *
 * @param {{ id: string, appointmentId: string }} entry
 */
export async function addEntry({ id, appointmentId }) {
  await pool.query(
    `INSERT IGNORE INTO waitlist (id, appointment_id) VALUES (?, ?)`,
    [id, appointmentId],
  );
}

/**
 * Entrada por id, con los datos de su cita (JOIN).
 *
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function getEntryById(id) {
  const [rows] = await pool.query(
    `SELECT ${ENTRY_JOIN_FIELDS}
       FROM waitlist w
       JOIN appointments a ON a.id = w.appointment_id
      WHERE w.id = ?
      LIMIT 1`,
    [id],
  );
  return rows.length === 0 ? null : rowToEntry(rows[0]);
}

/**
 * Candidatas elegibles para un hueco liberado: en espera, con cita activa
 * POSTERIOR al hueco (solo tiene sentido adelantar, no atrasar), excluyendo
 * las que ya rechazaron este hueco. Ordenadas por cercanía de su cita.
 *
 * @param {{ afterUtc: Date | string, excludeIds?: string[] }} args
 * @returns {Promise<object[]>}
 */
export async function getWaitingCandidates({ afterUtc, excludeIds = [] }) {
  const params = [afterUtc];
  let excludeClause = '';
  if (excludeIds.length > 0) {
    excludeClause = 'AND w.id NOT IN (?)';
    params.push(excludeIds);
  }

  const [rows] = await pool.query(
    `SELECT ${ENTRY_JOIN_FIELDS}
       FROM waitlist w
       JOIN appointments a ON a.id = w.appointment_id
      WHERE w.status = 'waiting'
        AND a.status IN ('pending', 'confirmed')
        AND a.scheduled_at > ?
        ${excludeClause}
      ORDER BY a.scheduled_at ASC`,
    params,
  );
  return rows.map(rowToEntry);
}

/**
 * Lista de espera completa (la doctora la pide a voluntad — revisión 25/09):
 * entradas en espera con cita activa futura, de la cita más cercana a la más
 * lejana. Mismo criterio de elegibilidad que un hueco que empieza "ahora".
 *
 * @param {Date} [now]
 * @returns {Promise<object[]>}
 */
export async function getWaitingEntries(now = new Date()) {
  return getWaitingCandidates({ afterUtc: now });
}

/**
 * Limpieza periódica (job de las 01:00): borra las entradas cuya cita ya no
 * está activa (completada, cancelada, reagendada) o ya pasó. La elegibilidad
 * ya las excluía al consultar; esto evita que la tabla acumule historial
 * muerto (actualización 23/09).
 *
 * @returns {Promise<number>}  Entradas borradas
 */
export async function purgeStaleEntries() {
  const [result] = await pool.query(
    `DELETE w FROM waitlist w
       JOIN appointments a ON a.id = w.appointment_id
      WHERE a.status NOT IN ('pending', 'confirmed')
         OR a.scheduled_at < NOW()`,
  );
  if (result.affectedRows > 0) {
    log.info({ count: result.affectedRows }, 'Entradas viejas de la lista de espera eliminadas');
  }
  return result.affectedRows;
}

export async function markEntryFulfilled(id) {
  await pool.query(`UPDATE waitlist SET status = 'fulfilled' WHERE id = ?`, [id]);
}

/**
 * Al reagendar una cita, su entrada de waitlist sigue a la cita nueva (la
 * paciente sigue esperando un hueco más cercano, ahora relativo a su nueva
 * fecha). No-op si la cita vieja no estaba en lista.
 */
export async function moveEntryToAppointment(oldAppointmentId, newAppointmentId) {
  const [result] = await pool.query(
    `UPDATE waitlist SET appointment_id = ?
      WHERE appointment_id = ? AND status = 'waiting'`,
    [newAppointmentId, oldAppointmentId],
  );
  if (result.affectedRows > 0) {
    log.info({ oldAppointmentId, newAppointmentId }, 'Entrada de waitlist movida a la cita nueva');
  }
}

// ─── slot_offers ─────────────────────────────────────────────────────────────

function rowToOffer(row) {
  return {
    id: row.id,
    sourceAppointmentId: row.source_appointment_id,
    location: row.location,
    scheduledAt: row.scheduled_at,
    durationMin: row.duration_min,
    status: row.status,
    offeredWaitlistId: row.offered_waitlist_id,
    declinedWaitlistIds: row.declined_waitlist_ids ?? [],
    offerMessageId: row.offer_message_id,
    doctorBrowsedAt: row.doctor_browsed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const OFFER_FIELDS = `
  id, source_appointment_id, location, scheduled_at, duration_min,
  status, offered_waitlist_id, declined_waitlist_ids, offer_message_id,
  doctor_browsed_at, created_at, updated_at
`;

/**
 * @param {{ id: string, sourceAppointmentId: string | null, location: string,
 *           scheduledAt: Date | string, durationMin: number }} offer
 */
export async function createOffer({ id, sourceAppointmentId, location, scheduledAt, durationMin }) {
  await pool.query(
    `INSERT INTO slot_offers (id, source_appointment_id, location, scheduled_at, duration_min)
          VALUES (?, ?, ?, ?, ?)`,
    [id, sourceAppointmentId, location, scheduledAt, durationMin],
  );
}

/**
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function getOfferById(id) {
  const [rows] = await pool.query(
    `SELECT ${OFFER_FIELDS} FROM slot_offers WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows.length === 0 ? null : rowToOffer(rows[0]);
}

/**
 * Oferta cuyo mensaje a la paciente tiene este wamid (statuses de entrega).
 *
 * @param {string} messageId
 * @returns {Promise<object | null>}
 */
export async function getOfferByMessageId(messageId) {
  const [rows] = await pool.query(
    `SELECT ${OFFER_FIELDS} FROM slot_offers WHERE offer_message_id = ? LIMIT 1`,
    [messageId],
  );
  return rows.length === 0 ? null : rowToOffer(rows[0]);
}

/**
 * Oferta cuya lista la doctora abrió más recientemente y que sigue en sus
 * manos: su siguiente mensaje de texto se interpreta como el nombre de una
 * paciente. La ventana de 24h empata con la de WhatsApp.
 *
 * @returns {Promise<object | null>}
 */
export async function getBrowsingOffer() {
  const [rows] = await pool.query(
    `SELECT ${OFFER_FIELDS}
       FROM slot_offers
      WHERE status = 'pending_doctor'
        AND doctor_browsed_at IS NOT NULL
        AND doctor_browsed_at >= NOW() - INTERVAL 24 HOUR
        AND scheduled_at > NOW()
      ORDER BY doctor_browsed_at DESC
      LIMIT 1`,
  );
  return rows.length === 0 ? null : rowToOffer(rows[0]);
}

/** La doctora abrió (o sigue usando) la lista en texto de esta oferta. */
export async function markOfferBrowsed(offerId) {
  await pool.query(`UPDATE slot_offers SET doctor_browsed_at = NOW() WHERE id = ?`, [offerId]);
}

/**
 * La doctora pidió la lista completa: ninguna lista de hueco queda abierta, así
 * que su siguiente texto se busca en la lista completa (la última lista que
 * abrió manda).
 */
export async function clearDoctorBrowsing() {
  await pool.query(
    `UPDATE slot_offers SET doctor_browsed_at = NULL WHERE doctor_browsed_at IS NOT NULL`,
  );
}

/**
 * Oferta que espera la respuesta de esta paciente (para no mandarle dos a la
 * vez).
 *
 * @param {string} waitlistId
 * @returns {Promise<object | null>}
 */
export async function getPendingOfferForEntry(waitlistId) {
  const [rows] = await pool.query(
    `SELECT ${OFFER_FIELDS}
       FROM slot_offers
      WHERE status = 'offered_patient'
        AND offered_waitlist_id = ?
        AND scheduled_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1`,
    [waitlistId],
  );
  return rows.length === 0 ? null : rowToOffer(rows[0]);
}

/**
 * Oferta abierta (en manos de la doctora o esperando a una paciente) para un
 * horario exacto. Una oferta a voluntad sobre un hueco que ya tiene oferta la
 * reusa en vez de duplicarla.
 *
 * @param {{ location: string, scheduledAt: Date }} slot
 * @returns {Promise<object | null>}
 */
export async function getOpenOfferForSlot({ location, scheduledAt }) {
  const [rows] = await pool.query(
    `SELECT ${OFFER_FIELDS}
       FROM slot_offers
      WHERE status IN ('pending_doctor', 'offered_patient')
        AND location = ?
        AND scheduled_at = ?
      ORDER BY FIELD(status, 'offered_patient', 'pending_doctor'), created_at DESC
      LIMIT 1`,
    [location, scheduledAt],
  );
  return rows.length === 0 ? null : rowToOffer(rows[0]);
}

/** La doctora eligió paciente: la oferta queda esperando su respuesta. */
export async function markOfferedToPatient(offerId, waitlistId) {
  await pool.query(
    `UPDATE slot_offers
        SET status = 'offered_patient', offered_waitlist_id = ?, offer_message_id = NULL
      WHERE id = ?`,
    [waitlistId, offerId],
  );
}

/** Guarda el wamid de la oferta enviada a la paciente. */
export async function setOfferMessageId(offerId, messageId) {
  await pool.query(`UPDATE slot_offers SET offer_message_id = ? WHERE id = ?`, [messageId, offerId]);
}

/**
 * La paciente rechazó: se registra su entrada como declinada y la oferta
 * regresa a manos de la doctora.
 */
export async function markOfferDeclined(offerId, waitlistId) {
  await pool.query(
    `UPDATE slot_offers
        SET status = 'pending_doctor',
            offered_waitlist_id = NULL,
            offer_message_id = NULL,
            declined_waitlist_ids = JSON_ARRAY_APPEND(
              COALESCE(declined_waitlist_ids, JSON_ARRAY()), '$', ?)
      WHERE id = ?`,
    [waitlistId, offerId],
  );
}

/** Regresa la oferta a la doctora sin registrar rechazo (ej. envío fallido). */
export async function revertOfferToDoctor(offerId) {
  await pool.query(
    `UPDATE slot_offers
        SET status = 'pending_doctor', offered_waitlist_id = NULL, offer_message_id = NULL
      WHERE id = ?`,
    [offerId],
  );
}

export async function markOfferAccepted(offerId) {
  await pool.query(`UPDATE slot_offers SET status = 'accepted' WHERE id = ?`, [offerId]);
}

/** Cierra la oferta (dejar libre, hueco ocupado por otra vía, o expirado). */
export async function closeOffer(offerId) {
  await pool.query(`UPDATE slot_offers SET status = 'closed' WHERE id = ?`, [offerId]);
}

/**
 * Limpieza periódica: cierra las ofertas abiertas cuyo hueco ya pasó.
 *
 * @returns {Promise<number>}  Ofertas cerradas
 */
export async function closeExpiredOffers() {
  const [result] = await pool.query(
    `UPDATE slot_offers
        SET status = 'closed'
      WHERE status IN ('pending_doctor', 'offered_patient')
        AND scheduled_at < NOW()`,
  );
  if (result.affectedRows > 0) {
    log.info({ count: result.affectedRows }, 'Ofertas de lista de espera vencidas cerradas');
  }
  return result.affectedRows;
}
