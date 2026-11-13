/**
 * availabilityService — calcula fechas y horarios disponibles.
 *
 * Cruza los horarios base de availability.json (hora del consultorio) contra
 * las citas activas en MySQL, los eventos reales del calendario CalDAV
 * (Fase 2: bloqueos que la doctora pone a mano en iCloud) y filtra slots
 * pasados.
 *
 * Un slot está disponible si:
 *   1. Cae dentro de la ventana del día para ese consultorio.
 *   2. La consulta completa (durationMin) termina antes del cierre.
 *   3. Empieza en el futuro (no ofrecemos horas que ya pasaron).
 *   4. No se traslapa con ninguna cita activa (pending/confirmed) en ese
 *      consultorio.
 *   5. No se traslapa con ningún evento del calendario de la doctora
 *      (cualquier consultorio: ella no puede estar en dos lados a la vez).
 *
 * Si CalDAV no está configurado o no responde, la disponibilidad se degrada
 * a MySQL-only (fail-open) con log de error: preferimos arriesgar un choque
 * con un bloqueo manual (raro, la doctora recibe notificación de cada cita y
 * puede reagendar) que dejar de agendar por completo cuando iCloud falla.
 */

import { LOCATION_KEYS, locationSchedule } from '../data/locations.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import * as appointmentRepository from './appointmentRepository.js';
import * as calendarService from './calendarService.js';
import {
  addDays,
  addMinutes,
  clinicTimeToUtc,
  formatDDMMYYYY,
  formatLongDateEs,
  formatShortDateEs,
  getClinicParts,
  parseDDMMYYYY,
  parseHHMM,
} from '../lib/dates.js';

const log = logger.child({ module: 'availabilityService' });

/**
 * Días hacia adelante que se exploran buscando disponibilidad
 * (AVAILABILITY_SEARCH_DAYS, default 60 — la agenda real se llena con ~1 mes
 * de anticipación y con una ventana corta el bot ofrecía una sola fecha).
 */
export const SEARCH_DAYS = config.AVAILABILITY_SEARCH_DAYS;

/** Máximo de fechas a ofrecer en el List Message (límite práctico de UX). */
export const MAX_DATES = 5;

// Colchón hacia atrás al leer citas de la DB: una cita que empezó antes del
// rango puede seguir ocupando slots dentro de él. 2h cubre la consulta más
// larga con margen.
const OVERLAP_LOOKBACK_MINUTES = 120;

/**
 * Consultorios configurados (slugs de availability.json).
 *
 * @returns {string[]}  Ej. ["norte", "sur"]
 */
export function getLocations() {
  return [...LOCATION_KEYS];
}

/**
 * Próximas fechas con al menos un slot libre para un consultorio y duración.
 *
 * @param {{ location: string, durationMin: number, maxDates?: number, searchDays?: number,
 *           beforeUtc?: Date | null }} args  beforeUtc: solo slots que empiecen antes
 *   de ese instante (la doctora adelantando la cita de una paciente de la lista
 *   de espera)
 * @returns {Promise<Array<{ date: string, label: string, shortLabel: string, slots: string[] }>>}
 *   date en DD/MM/YYYY; label larga ("miércoles 8 de julio") para cuerpos de
 *   mensaje; shortLabel ("Mié 8 jul") para items de List Message.
 */
export async function getAvailableDates({
  location,
  durationMin,
  maxDates = MAX_DATES,
  searchDays = SEARCH_DAYS,
  beforeUtc = null,
}) {
  const schedule = locationSchedule(location);
  if (!schedule) {
    throw new Error(`availabilityService: consultorio desconocido "${location}"`);
  }

  const now = new Date();
  if (beforeUtc && beforeUtc <= now) return [];
  let rangeEnd = addDays(now, searchDays + 1);
  // Con tope, basta leer hasta donde terminaría el último slot posible.
  if (beforeUtc && addMinutes(beforeUtc, durationMin) < rangeEnd) {
    rangeEnd = addMinutes(beforeUtc, durationMin);
  }
  const [appointments, calendarEvents] = await Promise.all([
    appointmentRepository.getActiveInRange({
      location,
      startUtc: addMinutes(now, -OVERLAP_LOOKBACK_MINUTES),
      endUtc: rangeEnd,
    }),
    getCalendarEvents(now, rangeEnd),
  ]);

  const results = [];
  for (let offset = 0; offset < searchDays && results.length < maxDates; offset++) {
    const dayParts = getClinicParts(addDays(now, offset));
    if (beforeUtc && clinicTimeToUtc({ ...dayParts, hour: 0, minute: 0 }) >= beforeUtc) break;
    const window = schedule[dayParts.weekday];
    if (!window) continue;

    const slots = buildDaySlots({ dayParts, window, durationMin, now, appointments, calendarEvents, beforeUtc });
    if (slots.length === 0) continue;

    const noonUtc = clinicTimeToUtc({ ...dayParts, hour: 12, minute: 0 });
    results.push({
      date: formatDDMMYYYY(dayParts),
      label: formatLongDateEs(noonUtc),
      shortLabel: formatShortDateEs(noonUtc),
      slots,
    });
  }

  return results;
}

/**
 * Slots libres de un día específico (recalculados al momento — la
 * disponibilidad pudo cambiar desde que se ofreció la fecha).
 *
 * @param {{ location: string, date: string, durationMin: number, beforeUtc?: Date | null }} args
 *   date en DD/MM/YYYY; beforeUtc como en getAvailableDates
 * @returns {Promise<string[]>}  Horas "HH:mm" en hora del consultorio
 */
export async function getAvailableSlots({ location, date, durationMin, beforeUtc = null }) {
  const schedule = locationSchedule(location);
  if (!schedule) {
    throw new Error(`availabilityService: consultorio desconocido "${location}"`);
  }

  const parsedDate = parseDDMMYYYY(date);
  if (!parsedDate) {
    throw new Error(`availabilityService: fecha inválida "${date}" (se espera DD/MM/YYYY)`);
  }

  const dayStartUtc = clinicTimeToUtc({ ...parsedDate, hour: 0, minute: 0 });
  const dayParts = getClinicParts(addMinutes(dayStartUtc, 12 * 60));
  const window = schedule[dayParts.weekday];
  if (!window) return [];

  const now = new Date();
  const dayEndUtc = addDays(dayStartUtc, 1);
  const [appointments, calendarEvents] = await Promise.all([
    appointmentRepository.getActiveInRange({
      location,
      startUtc: addMinutes(dayStartUtc, -OVERLAP_LOOKBACK_MINUTES),
      endUtc: dayEndUtc,
    }),
    getCalendarEvents(dayStartUtc, dayEndUtc),
  ]);

  return buildDaySlots({ dayParts, window, durationMin, now, appointments, calendarEvents, beforeUtc });
}

/**
 * Verifica que un slot puntual siga libre. Última línea de defensa justo
 * antes de confirmar la cita (otra paciente pudo ganar el horario mientras
 * esta terminaba el flujo).
 *
 * @param {{ location: string, date: string, time: string, durationMin: number }} args
 * @returns {Promise<boolean>}
 */
export async function isSlotFree({ location, date, time, durationMin }) {
  const scheduledAt = slotToUtc(date, time);
  const slotEnd = addMinutes(scheduledAt, durationMin);

  const [overlapping, calendarEvents] = await Promise.all([
    appointmentRepository.getOverlapping({ scheduledAt, durationMin, location }),
    getCalendarEvents(scheduledAt, slotEnd),
  ]);

  return (
    overlapping.length === 0 &&
    !calendarEvents.some((e) => e.start < slotEnd && scheduledAt < e.end)
  );
}

/**
 * Convierte un slot (fecha DD/MM/YYYY + hora HH:mm del consultorio) a su
 * instante UTC, listo para guardarse en la DB.
 *
 * @param {string} date
 * @param {string} time
 * @returns {Date}
 */
export function slotToUtc(date, time) {
  const parsedDate = parseDDMMYYYY(date);
  const parsedTime = parseHHMM(time);
  if (!parsedDate || !parsedTime) {
    throw new Error(`availabilityService: slot inválido "${date} ${time}"`);
  }
  return clinicTimeToUtc({ ...parsedDate, ...parsedTime });
}

// ─── Internos ────────────────────────────────────────────────────────────────

/**
 * Eventos del calendario que se traslapan con [from, to]. Fail-open: sin
 * configuración o con iCloud caído devuelve [] (ver nota en el header).
 */
async function getCalendarEvents(from, to) {
  if (!calendarService.isConfigured()) return [];
  try {
    return await calendarService.listEvents({ from, to });
  } catch (err) {
    log.error(
      { err },
      'Calendarios no disponibles — disponibilidad calculada solo con MySQL (bloqueos manuales ignorados)',
    );
    return [];
  }
}

function buildDaySlots({
  dayParts, window, durationMin, now, appointments, calendarEvents = [], beforeUtc = null,
}) {
  const start = parseHHMM(window.start);
  const end = parseHHMM(window.end);
  if (!start || !end || !Number.isInteger(window.slotMinutes) || window.slotMinutes <= 0) {
    throw new Error(
      `availabilityService: ventana mal formada en availability.json para ${dayParts.weekday}`,
    );
  }

  const windowEndUtc = clinicTimeToUtc({ ...dayParts, ...end });
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;

  // Se calculan TODOS los slots del día — el límite de 10 items de WhatsApp
  // se resuelve con paginación en la capa de presentación (messageBuilder).
  const slots = [];
  for (let m = startMinutes; m < endMinutes; m += window.slotMinutes) {
    const slotStartUtc = clinicTimeToUtc({
      ...dayParts,
      hour: Math.floor(m / 60),
      minute: m % 60,
    });
    const slotEndUtc = addMinutes(slotStartUtc, durationMin);

    if (slotEndUtc > windowEndUtc) break;          // la consulta no cabe antes del cierre
    if (beforeUtc && slotStartUtc >= beforeUtc) break;
    if (slotStartUtc <= now) continue;             // hora ya pasada
    if (overlapsAny(slotStartUtc, slotEndUtc, appointments)) continue;
    if (overlapsAnyEvent(slotStartUtc, slotEndUtc, calendarEvents)) continue;

    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    slots.push(`${hh}:${mm}`);
  }

  return slots;
}

// Dos rangos [a, b) y [c, d) se traslapan si a < d AND c < b.
function overlapsAny(startUtc, endUtc, appointments) {
  return appointments.some((appt) => {
    const apptStart = new Date(appt.scheduledAt);
    const apptEnd = addMinutes(apptStart, appt.durationMin);
    return apptStart < endUtc && startUtc < apptEnd;
  });
}

// Eventos de CalDAV: ya vienen con start/end como Date (ver caldavService).
// Nota: los eventos que el propio bot creó duplican citas que ya están en
// MySQL — bloquean el mismo intervalo dos veces, lo cual es inofensivo.
function overlapsAnyEvent(startUtc, endUtc, events) {
  return events.some((e) => e.start < endUtc && startUtc < e.end);
}
