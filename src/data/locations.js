/**
 * Acceso a los consultorios definidos en availability.json.
 *
 * La llave de cada consultorio es un slug estable ("norte", "sur") que
 * viaja en los IDs de botones (loc_norte), en la columna `location` de la DB
 * y en las env vars CALDAV_CALENDAR_<SLUG>. Los nombres visibles viven aparte:
 * `label` (completo, para cuerpos de mensaje) y `buttonLabel` (corto, para
 * botones de WhatsApp con límite de 20 chars).
 *
 * Módulo de datos puro (solo lee el JSON): importable desde cualquier capa
 * sin riesgo de imports circulares.
 */

import availability from './availability.json' with { type: 'json' };

/** Slugs de los consultorios configurados. Ej. ["norte", "sur"] */
export const LOCATION_KEYS = Object.keys(availability).filter((key) => !key.startsWith('_'));

/** Nombre completo del consultorio ("Clínica Sur"). */
export function locationLabel(key) {
  return availability[key]?.label ?? key;
}

/** Nombre corto para botones de WhatsApp ("Clínica Sur", ≤20 chars). */
export function locationButtonLabel(key) {
  return availability[key]?.buttonLabel ?? locationLabel(key);
}

/** Torre/consultorio dentro del hospital, o null si no está configurado. */
export function locationDetail(key) {
  return availability[key]?.detail ?? null;
}

/**
 * Nombre completo + torre/consultorio, para mensajes a la PACIENTE
 * ("Clínica Sur, Piso 3, Consultorio 301"). Las
 * notificaciones a la doctora usan locationLabel — ella conoce sus
 * consultorios y el detalle solo hace ruido.
 */
export function locationFullLabel(key) {
  const detail = locationDetail(key);
  return detail ? `${locationLabel(key)}, ${detail}` : locationLabel(key);
}

/**
 * Mensaje de la doctora con indicaciones de llegada al consultorio, o null.
 * Se envía una sola vez por paciente, la primera vez que agenda ahí
 * (appointmentFlow, estado SHOWING_LOCATION_INFO).
 */
export function locationFirstVisitInfo(key) {
  return availability[key]?.firstVisitInfo ?? null;
}

/** Palabras clave que identifican al consultorio en texto libre. */
export function locationKeywords(key) {
  return availability[key]?.keywords ?? [key];
}

/** Ventanas de horario por día: { monday: { start, end, slotMinutes }, ... } */
export function locationSchedule(key) {
  return availability[key]?.schedule ?? null;
}
