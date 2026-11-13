import { pool } from '../db/connection.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'stateManager' });

const TIMEOUT_MS = config.CONVERSATION_TIMEOUT_MIN * 60 * 1000;

/**
 * Devuelve el estado conversacional de una paciente.
 * Si la conversación rebasó el timeout de inactividad, la borra y devuelve null
 * — el flow la trata como conversación nueva sin tener que checar tiempos.
 *
 * @param {string} phone  Teléfono normalizado (ej. "+5215512345678")
 * @returns {Promise<{phone, currentStep, flowType, contextData, updatedAt} | null>}
 */

export async function getState(phone) {
  const [rows] = await pool.query(
    `SELECT phone, current_step, flow_type, context_data, updated_at
      FROM conversations
      WHERE phone = ?
      LIMIT 1`,
    [phone],
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  const ageMs = Date.now() - new Date(row.updated_at).getTime();

  if (ageMs > TIMEOUT_MS) {
    await clearState(phone);
    log.info({ phone, ageMinutes: Math.round(ageMs / 60_000) }, 'Conversación expirada por inactividad');
    return null;
  }

  return {
    phone: row.phone,
    currentStep: row.current_step,
    flowType: row.flow_type,
    contextData: row.context_data ?? null,
    updatedAt: row.updated_at,
  };
}

/**
 * Crea o actualiza el estado conversacional (upsert por teléfono).
 * Serializa contextData a JSON antes de guardarlo.
 *
 * @param {string} phone
 * @param {{ currentStep: string, flowType: 'appointment'|'reschedule'|'cancellation', contextData?: object | null }} state
 */
export async function setState(phone, { currentStep, flowType, contextData = null }) {
  const serializedContext = contextData == null ? null : JSON.stringify(contextData);

  await pool.query(
    `INSERT INTO conversations (phone, current_step, flow_type, context_data)
          VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
          current_step = VALUES(current_step),
          flow_type    = VALUES(flow_type),
          context_data = VALUES(context_data)`,
    [phone, currentStep, flowType, serializedContext],
  );
}

/**
 * Borra el estado conversacional. Se llama cuando el flujo termina,
 * la paciente cancela, o se detecta expiración.
 *
 * @param {string} phone
 */
export async function clearState(phone) {
  await pool.query('DELETE FROM conversations WHERE phone = ?', [phone]);
}

/**
 * Refresca el `updated_at` sin tocar el resto del estado.
 * Útil cuando llega un mensaje que no avanza el flujo (ej. "ayuda" o un
 * input inválido) pero queremos extender el TTL.
 *
 * No-op si no existe conversación para ese teléfono.
 *
 * @param {string} phone
 */
export async function touchState(phone) {
  await pool.query('UPDATE conversations SET updated_at = NOW() WHERE phone = ?', [phone]);
}
