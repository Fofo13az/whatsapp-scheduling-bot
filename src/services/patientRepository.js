import { pool } from '../db/connection.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'patientRepository' });

/**
 * Busca una paciente por teléfono.
 *
 * @param {string} phone
 * @returns {Promise<{ phone, name, createdAt } | null>}
 */
export async function getByPhone(phone) {
  const [rows] = await pool.query(
    'SELECT phone, name, created_at FROM patients WHERE phone = ? LIMIT 1',
    [phone],
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    phone: row.phone,
    name: row.name,
    createdAt: row.created_at,
  };
}

/**
 * Crea o actualiza el registro de la paciente. Solo guarda nombre — no hay
 * contadores denormalizados. Si el nombre cambia entre citas (ej. corrección
 * de typo), el upsert lo refresca al más reciente.
 *
 * @param {string} phone
 * @param {string} name
 */
export async function upsertPatientInfo(phone, name) {
  await pool.query(
    `INSERT INTO patients (phone, name)
          VALUES (?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [phone, name],
  );
}

/**
 * Indica si una paciente ya completó al menos una consulta.
 * Define "primera vez" vs. "recurrente" para efectos de:
 *   - Duración del slot (primera vez = más larga)
 *   - Detalle de notificación a la doctora
 *
 * No-shows quedan contados como completed (limitación conocida).
 *
 * @param {string} phone
 * @returns {Promise<boolean>}
 */
export async function hasCompletedAppointments(phone) {
  const [rows] = await pool.query(
    `SELECT 1 FROM appointments
      WHERE patient_phone = ? AND status = 'completed'
      LIMIT 1`,
    [phone],
  );
  return rows.length > 0;
}
