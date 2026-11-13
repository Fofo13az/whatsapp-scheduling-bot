import { pool } from '../db/connection.js';
import { logger } from '../lib/logger.js';
import { mxPhoneVariants } from '../lib/phones.js';

const log = logger.child({ module: 'appointmentRepository' });

const SELECT_FIELDS = `
  id, patient_phone, patient_name, consultation_type, location,
  scheduled_at, duration_min, status, patient_notes, caldav_event_uid,
  created_at, reminder_sent_at, reminder_message_id, reminder_delivery_status,
  reminder_delivery_error, confirmed_at, cancelled_at, rescheduled_from_id
`;

function rowToAppointment(row) {
  return {
    id: row.id,
    patientPhone: row.patient_phone,
    patientName: row.patient_name,
    consultationType: row.consultation_type,
    location: row.location,
    scheduledAt: row.scheduled_at,
    durationMin: row.duration_min,
    status: row.status,
    patientNotes: row.patient_notes,
    caldavEventUid: row.caldav_event_uid,
    createdAt: row.created_at,
    reminderSentAt: row.reminder_sent_at,
    reminderMessageId: row.reminder_message_id,
    reminderDeliveryStatus: row.reminder_delivery_status,
    reminderDeliveryError: row.reminder_delivery_error,
    confirmedAt: row.confirmed_at,
    cancelledAt: row.cancelled_at,
    rescheduledFromId: row.rescheduled_from_id,
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────

/**
 * @param {string} id  UUID de la cita
 * @returns {Promise<object | null>}
 */
export async function getById(id) {
  const [rows] = await pool.query(
    `SELECT ${SELECT_FIELDS} FROM appointments WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows.length === 0 ? null : rowToAppointment(rows[0]);
}

/**
 * Citas activas (futuras y no canceladas) de una paciente, ordenadas
 * cronológicamente. Lo que necesitan los flujos de cancelar/reagendar
 * para ofrecer opciones.
 *
 * @param {string} phone
 * @returns {Promise<object[]>}
 */
export async function getActiveByPhone(phone) {
  const [rows] = await pool.query(
    `SELECT ${SELECT_FIELDS}
       FROM appointments
      WHERE patient_phone = ?
        AND status IN ('pending', 'confirmed')
        AND scheduled_at >= NOW()
      ORDER BY scheduled_at ASC`,
    [phone],
  );
  return rows.map(rowToAppointment);
}

/**
 * Citas dentro de un rango de tiempo (en UTC). Usado por el cron de
 * recordatorios para encontrar las del día siguiente en CDMX, ya
 * convertidas a UTC por el caller.
 *
 * Solo devuelve las que aún no han recibido recordatorio (idempotencia).
 *
 * @param {Date | string} startUtc  Inclusive
 * @param {Date | string} endUtc    Exclusive
 * @returns {Promise<object[]>}
 */
export async function getForReminderRange(startUtc, endUtc) {
  const [rows] = await pool.query(
    `SELECT ${SELECT_FIELDS}
       FROM appointments
      WHERE scheduled_at >= ?
        AND scheduled_at <  ?
        AND status IN ('pending', 'confirmed')
        AND reminder_sent_at IS NULL
      ORDER BY scheduled_at ASC`,
    [startUtc, endUtc],
  );
  return rows.map(rowToAppointment);
}

/**
 * Citas con recordatorio enviado recientemente que siguen sin confirmar.
 * Usado por el chequeo de no-respuesta del scheduler (un rato después del
 * envío nocturno) para avisar a la doctora.
 *
 * Excluye los recordatorios que Meta reportó como NO entregados: la doctora
 * ya recibió el aviso de "no entregado" en el momento, y decirle después que
 * la paciente "no ha respondido" sería engañoso (bug del 23/09).
 *
 * @param {Date | string} sinceUtc  Solo recordatorios enviados desde este instante
 * @returns {Promise<object[]>}
 */
export async function getUnconfirmedReminded(sinceUtc) {
  const [rows] = await pool.query(
    `SELECT ${SELECT_FIELDS}
       FROM appointments
      WHERE status = 'pending'
        AND reminder_sent_at IS NOT NULL
        AND reminder_sent_at >= ?
        AND (reminder_delivery_status IS NULL OR reminder_delivery_status <> 'failed')
      ORDER BY scheduled_at ASC`,
    [sinceUtc],
  );
  return rows.map(rowToAppointment);
}

/**
 * Próxima cita de una paciente con recordatorio ya enviado y aún sin
 * confirmar. Permite interpretar un "sí" de texto libre como respuesta al
 * recordatorio aunque el estado conversacional ya haya expirado.
 *
 * @param {string} phone
 * @returns {Promise<object | null>}
 */
export async function getPendingRemindedByPhone(phone) {
  const [rows] = await pool.query(
    `SELECT ${SELECT_FIELDS}
       FROM appointments
      WHERE patient_phone = ?
        AND status = 'pending'
        AND reminder_sent_at IS NOT NULL
        AND scheduled_at >= NOW()
      ORDER BY scheduled_at ASC
      LIMIT 1`,
    [phone],
  );
  return rows.length === 0 ? null : rowToAppointment(rows[0]);
}

/**
 * Cita cuyo recordatorio tiene este wamid (para los statuses de entrega).
 *
 * @param {string} messageId  wamid devuelto por la Cloud API
 * @returns {Promise<object | null>}
 */
export async function getByReminderMessageId(messageId) {
  const [rows] = await pool.query(
    `SELECT ${SELECT_FIELDS} FROM appointments WHERE reminder_message_id = ? LIMIT 1`,
    [messageId],
  );
  return rows.length === 0 ? null : rowToAppointment(rows[0]);
}

/**
 * Citas activas futuras con evento de calendario ligado, para el barrido
 * diario de sincronización contra el calendario (calendarSync).
 *
 * @returns {Promise<object[]>}
 */
export async function getActiveFutureWithEvent() {
  const [rows] = await pool.query(
    `SELECT ${SELECT_FIELDS}
       FROM appointments
      WHERE status IN ('pending', 'confirmed')
        AND scheduled_at > NOW()
        AND caldav_event_uid IS NOT NULL
      ORDER BY scheduled_at ASC`,
  );
  return rows.map(rowToAppointment);
}

/**
 * ¿La paciente ya agendó alguna vez en este consultorio? Cualquier status
 * cuenta: incluso una cita cancelada implica que pasó por el flujo y ya
 * recibió el mensaje de indicaciones de llegada (firstVisitInfo).
 *
 * @param {string} phone
 * @param {string} location  Slug de availability.json
 * @returns {Promise<boolean>}
 */
export async function hasAnyAtLocation(phone, location) {
  const variants = mxPhoneVariants(phone);
  const [rows] = await pool.query(
    `SELECT 1 FROM appointments
      WHERE patient_phone IN (?) AND location = ?
      LIMIT 1`,
    [variants, location],
  );
  return rows.length > 0;
}

/**
 * Citas activas (pending/confirmed) de un consultorio dentro de un rango UTC.
 * Usado por availabilityService para calcular disponibilidad con una sola
 * query en lugar de un getOverlapping por slot candidato.
 *
 * El caller debe extender el inicio del rango hacia atrás (~2h) para no
 * perder citas que empiezan antes del rango pero se traslapan dentro de él.
 *
 * @param {{ location: string, startUtc: Date | string, endUtc: Date | string }} args
 * @returns {Promise<object[]>}
 */
export async function getActiveInRange({ location, startUtc, endUtc }) {
  const [rows] = await pool.query(
    `SELECT ${SELECT_FIELDS}
       FROM appointments
      WHERE location = ?
        AND status IN ('pending', 'confirmed')
        AND scheduled_at >= ?
        AND scheduled_at < ?
      ORDER BY scheduled_at ASC`,
    [location, startUtc, endUtc],
  );
  return rows.map(rowToAppointment);
}

/**
 * Citas que se traslapan con un rango propuesto en un consultorio dado.
 * Solo considera citas no canceladas. Usado por availabilityService
 * para validar que un slot esté libre antes de confirmar.
 *
 * Dos rangos [a, b) y [c, d) se traslapan si: a < d AND c < b.
 *
 * @param {{ scheduledAt: Date | string, durationMin: number, location: string }} args
 * @returns {Promise<object[]>}
 */
export async function getOverlapping({ scheduledAt, durationMin, location }) {
  const [rows] = await pool.query(
    `SELECT ${SELECT_FIELDS}
       FROM appointments
      WHERE location = ?
        AND status IN ('pending', 'confirmed')
        AND scheduled_at < (? + INTERVAL ? MINUTE)
        AND ? < (scheduled_at + INTERVAL duration_min MINUTE)`,
    [location, scheduledAt, durationMin, scheduledAt],
  );
  return rows.map(rowToAppointment);
}

// ─── Writes ───────────────────────────────────────────────────────────────

/**
 * Inserta una cita nueva con status='pending'. El UUID lo genera el caller
 * (típicamente con `crypto.randomUUID()`) para tener el ID antes del INSERT.
 *
 * @param {{
 *   id: string,
 *   patientPhone: string,
 *   patientName: string,
 *   consultationType: string,
 *   location: string,
 *   scheduledAt: Date | string,
 *   durationMin: number,
 *   patientNotes?: string | null,
 *   caldavEventUid?: string | null,
 *   rescheduledFromId?: string | null,
 * }} appointment
 */
export async function create({
  id,
  patientPhone,
  patientName,
  consultationType,
  location,
  scheduledAt,
  durationMin,
  patientNotes = null,
  caldavEventUid = null,
  rescheduledFromId = null,
}) {
  await pool.query(
    `INSERT INTO appointments (
       id, patient_phone, patient_name, consultation_type, location,
       scheduled_at, duration_min, status, patient_notes,
       caldav_event_uid, rescheduled_from_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [
      id, patientPhone, patientName, consultationType, location,
      scheduledAt, durationMin, patientNotes,
      caldavEventUid, rescheduledFromId,
    ],
  );
}

/**
 * Marca una cita como confirmada por la paciente (en respuesta al
 * recordatorio nocturno).
 */
export async function markConfirmed(id) {
  await pool.query(
    `UPDATE appointments
        SET status = 'confirmed', confirmed_at = NOW()
      WHERE id = ?`,
    [id],
  );
}

/**
 * Marca una cita como cancelada.
 */
export async function markCancelled(id) {
  await pool.query(
    `UPDATE appointments
        SET status = 'cancelled', cancelled_at = NOW()
      WHERE id = ?`,
    [id],
  );
}

/**
 * Marca una cita como reagendada. La cita nueva se crea por separado vía
 * create() pasándole rescheduledFromId con el id de esta.
 */
export async function markRescheduled(id) {
  await pool.query(
    `UPDATE appointments SET status = 'rescheduled' WHERE id = ?`,
    [id],
  );
}

/**
 * Registra que ya se envió el recordatorio nocturno. Idempotencia: el cron
 * filtra por reminder_sent_at IS NULL para no mandar dos veces.
 *
 * Guarda el wamid para correlacionar los statuses de entrega de Meta. El
 * status queda NULL ("Meta lo aceptó, sin acuse todavía") hasta que llegue el
 * primer status por el webhook.
 *
 * @param {string} id
 * @param {string | null} [messageId]  wamid devuelto por la Cloud API
 */
export async function markReminderSent(id, messageId = null) {
  await pool.query(
    `UPDATE appointments
        SET reminder_sent_at = NOW(),
            reminder_message_id = ?,
            reminder_delivery_status = NULL,
            reminder_delivery_error = NULL
      WHERE id = ?`,
    [messageId, id],
  );
}

/**
 * Avanza el status de entrega del recordatorio (sent → delivered → read).
 * Monótono: Meta puede mandar los statuses fuera de orden (read antes que
 * delivered) o repetidos; nunca retrocede ni pisa un 'failed'.
 *
 * @param {string} messageId
 * @param {'sent' | 'delivered' | 'read'} status
 * @returns {Promise<boolean>}  true si hubo cambio
 */
export async function advanceReminderDelivery(messageId, status) {
  const [result] = await pool.query(
    `UPDATE appointments
        SET reminder_delivery_status = ?
      WHERE reminder_message_id = ?
        AND (reminder_delivery_status IS NULL
             OR (reminder_delivery_status <> 'failed'
                 AND FIELD(reminder_delivery_status, 'sent', 'delivered', 'read')
                     < FIELD(?, 'sent', 'delivered', 'read')))`,
    [status, messageId, status],
  );
  return result.affectedRows > 0;
}

/**
 * Marca el recordatorio como NO entregado. Idempotente: si ya estaba en
 * 'failed' (Meta reenvió el webhook) devuelve false, para no avisar dos veces
 * a la doctora.
 *
 * @param {string} messageId
 * @param {string} error  Código + motivo de Meta (se trunca a 255)
 * @returns {Promise<boolean>}  true si se marcó ahora
 */
export async function markReminderFailed(messageId, error) {
  const [result] = await pool.query(
    `UPDATE appointments
        SET reminder_delivery_status = 'failed', reminder_delivery_error = ?
      WHERE reminder_message_id = ?
        AND (reminder_delivery_status IS NULL OR reminder_delivery_status <> 'failed')`,
    [String(error).slice(0, 255), messageId],
  );
  return result.affectedRows > 0;
}

/**
 * La doctora movió el evento en su calendario: la cita adopta el nuevo
 * horario (calendarSync). El recordatorio y la confirmación eran del horario
 * VIEJO, así que se reinician: la cita vuelve a 'pending' y recibe el
 * recordatorio de su nueva fecha (si no, una cita movida después de su
 * recordatorio se quedaría sin el de la fecha nueva).
 *
 * @param {string} id
 * @param {Date} scheduledAt
 * @param {number} durationMin
 */
export async function updateSchedule(id, scheduledAt, durationMin) {
  await pool.query(
    `UPDATE appointments
        SET scheduled_at = ?, duration_min = ?,
            status = 'pending', confirmed_at = NULL,
            reminder_sent_at = NULL, reminder_message_id = NULL,
            reminder_delivery_status = NULL, reminder_delivery_error = NULL
      WHERE id = ? AND status IN ('pending', 'confirmed')`,
    [scheduledAt, durationMin, id],
  );
}

/**
 * Asocia el UID del evento de iCloud a la cita. Se llama después de crear
 * el evento en CalDAV — necesitamos guardarlo para poder borrar el evento
 * en cancelaciones/reagendamientos.
 */
export async function attachCalDAVEvent(id, caldavEventUid) {
  await pool.query(
    `UPDATE appointments SET caldav_event_uid = ? WHERE id = ?`,
    [caldavEventUid, id],
  );
}

/**
 * Marca como completed todas las citas pending/confirmed cuya hora de
 * término ya pasó. Lo invoca el cron diario (Fase 3).
 *
 * Compromiso conocido: no-shows también quedan como completed. Para una
 * v1 con consultorio chico, el ruido es aceptable.
 *
 * @returns {Promise<number>}  Cantidad de citas marcadas
 */
export async function markCompletedBatch() {
  const [result] = await pool.query(
    `UPDATE appointments
        SET status = 'completed'
      WHERE status IN ('pending', 'confirmed')
        AND (scheduled_at + INTERVAL duration_min MINUTE) < NOW()`,
  );
  if (result.affectedRows > 0) {
    log.info({ count: result.affectedRows }, 'Citas marcadas como completed');
  }
  return result.affectedRows;
}
