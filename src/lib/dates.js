/**
 * Utilidades de fecha/hora para la zona horaria del consultorio.
 *
 * Regla del proyecto: la DB guarda todo en UTC (el pool corre con
 * timezone 'Z'); la conversión a hora local (America/Mexico_City) se hace
 * solo en presentación y al interpretar horarios de availability.json, que
 * están expresados en hora del consultorio.
 *
 * Sin dependencias: usamos Intl, que resuelve offsets por zona horaria
 * nativamente. CDMX no tiene DST desde 2022, pero el cálculo es genérico
 * por si TIMEZONE cambia.
 */

import { config } from '../config/index.js';

export const CLINIC_TZ = config.TIMEZONE;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const MS_PER_MINUTE = 60 * 1000;

// Un formatter por zona horaria: la del consultorio siempre, y las que
// aparezcan en TZIDs de eventos iCalendar (parser de ICS, Fase 2).
const partsFormatterCache = new Map();

function partsFormatterFor(timeZone) {
  let formatter = partsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'long',
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

const longDateFormatter = new Intl.DateTimeFormat('es-MX', {
  timeZone: CLINIC_TZ,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const shortDateFormatter = new Intl.DateTimeFormat('es-MX', {
  timeZone: CLINIC_TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

/**
 * Descompone un instante UTC en sus componentes de calendario en una zona
 * horaria arbitraria (por default, la del consultorio).
 *
 * @param {Date} date
 * @param {string} [timeZone]  Identificador IANA, ej. "America/Mexico_City"
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: string }}
 *   month 1-12; weekday en inglés minúsculas ("monday"...) para indexar availability.json.
 */
export function getWallParts(date, timeZone = CLINIC_TZ) {
  const parts = Object.fromEntries(
    partsFormatterFor(timeZone).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl puede reportar medianoche como "24" según el locale/ICU
    hour: parts.hour === '24' ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday.toLowerCase(),
  };
}

/**
 * Descompone un instante UTC en sus componentes de calendario en la zona
 * del consultorio.
 *
 * @param {Date} date
 * @returns {ReturnType<typeof getWallParts>}
 */
export function getClinicParts(date) {
  return getWallParts(date, CLINIC_TZ);
}

function wallOffsetMs(utcDate, timeZone) {
  const p = getWallParts(utcDate, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - utcDate.getTime();
}

/**
 * Convierte una fecha/hora "de pared" en una zona horaria arbitraria a su
 * instante UTC. La necesita el parser de ICS: los eventos de iCloud traen
 * DTSTART con TZID de cualquier zona.
 *
 * @param {{ year: number, month: number, day: number, hour?: number, minute?: number, second?: number }} wall  month 1-12
 * @param {string} [timeZone]  Identificador IANA
 * @returns {Date}
 */
export function wallTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = CLINIC_TZ) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  // Doble pasada por si el guess cae junto a un cambio de offset (no aplica
  // en CDMX actual, pero cuesta poco y hace la función correcta en general).
  const offset = wallOffsetMs(
    new Date(guess - wallOffsetMs(new Date(guess), timeZone)),
    timeZone,
  );
  return new Date(guess - offset);
}

/**
 * Convierte una fecha/hora "de pared" del consultorio a su instante UTC.
 * Ej.: { 2026, 7, 8, 10:00 } en CDMX → Date en 2026-07-08T16:00:00Z.
 *
 * @param {{ year: number, month: number, day: number, hour?: number, minute?: number }} wall  month 1-12
 * @returns {Date}
 */
export function clinicTimeToUtc(wall) {
  return wallTimeToUtc(wall, CLINIC_TZ);
}

/**
 * @param {Date} date
 * @param {number} days  Puede ser negativo
 * @returns {Date}
 */
export function addDays(date, days) {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/**
 * @param {Date} date
 * @param {number} minutes
 * @returns {Date}
 */
export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * MS_PER_MINUTE);
}

/**
 * Formatea componentes de calendario como "DD/MM/YYYY" (el formato usado en
 * los IDs de botones: date_08/07/2026, slot_08/07/2026_10:00).
 *
 * @param {{ year: number, month: number, day: number }} parts
 * @returns {string}
 */
export function formatDDMMYYYY({ year, month, day }) {
  const dd = String(day).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  return `${dd}/${mm}/${year}`;
}

/**
 * Parsea "DD/MM/YYYY" validando que sea una fecha real de calendario.
 *
 * @param {string} str
 * @returns {{ year: number, month: number, day: number } | null}
 */
export function parseDDMMYYYY(str) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(str ?? '');
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  // Validar contra el calendario real (rechaza 31/02, 00/xx, mes 13...)
  const probe = new Date(Date.UTC(year, month - 1, day));
  const valid =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;

  return valid ? { year, month, day } : null;
}

/**
 * Parsea "HH:mm" en 24h.
 *
 * @param {string} str
 * @returns {{ hour: number, minute: number } | null}
 */
export function parseHHMM(str) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(str ?? '');
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Etiqueta larga en español para cuerpos de mensaje: "miércoles 8 de julio".
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatLongDateEs(date) {
  return longDateFormatter.format(date).replace(',', '');
}

/**
 * Etiqueta corta para items de List Message (límite de 24 chars): "Mié 8 jul".
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatShortDateEs(date) {
  const raw = shortDateFormatter.format(date).replaceAll('.', '').replace(',', '');
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
