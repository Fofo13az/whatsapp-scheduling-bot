/**
 * calendarRouting — qué proveedor de calendario atiende a cada consultorio.
 *
 * Surge del E2E del 21/08: el calendario de Sur vive en la cuenta de
 * GOOGLE de la doctora (compartido con su secretaria, que agenda desde
 * Android) y solo se "muestra" en su Apple Calendar — el CalDAV de iCloud no
 * puede verlo. Norte sí es un calendario nativo de iCloud.
 *
 * Regla (solo config, sin tocar código):
 *   - GOOGLE_CALENDAR_<SLUG> definido → ese consultorio usa Google Calendar.
 *   - Si no → CalDAV (CALDAV_CALENDAR_<SLUG> o el fallback CALDAV_CALENDAR_NAME).
 *
 * Módulo puro (solo lee config): importable desde cualquier servicio de
 * calendario sin riesgo de imports circulares.
 */

import { LOCATION_KEYS } from '../data/locations.js';
import { config } from '../config/index.js';

/** ID del calendario de Google configurado para un consultorio, o null. */
export function googleCalendarIdFor(location) {
  return config[`GOOGLE_CALENDAR_${location.toUpperCase()}`] ?? null;
}

/** Nombre del calendario CalDAV configurado para un consultorio, o null. */
export function caldavCalendarNameFor(location) {
  const perLocation = config[`CALDAV_CALENDAR_${location.toUpperCase()}`];
  return perLocation ?? config.CALDAV_CALENDAR_NAME ?? null;
}

/**
 * @param {string} location
 * @returns {'google' | 'caldav'}
 */
export function providerFor(location) {
  return googleCalendarIdFor(location) ? 'google' : 'caldav';
}

/** Consultorios atendidos por Google Calendar. */
export function googleLocations() {
  return LOCATION_KEYS.filter((loc) => providerFor(loc) === 'google');
}

/** Consultorios atendidos por CalDAV (iCloud). */
export function caldavLocations() {
  return LOCATION_KEYS.filter((loc) => providerFor(loc) === 'caldav');
}
