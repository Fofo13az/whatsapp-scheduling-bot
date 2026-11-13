/**
 * caldavService — integración real con Apple Calendar vía CalDAV (tsdav).
 *
 * Autenticación: Basic con CALDAV_USERNAME + CALDAV_APP_SPECIFIC_PASSWORD
 * contra CALDAV_SERVER_URL (iCloud: https://caldav.icloud.com).
 *
 * Un calendario POR CONSULTORIO: la doctora organiza su agenda con un
 * calendario para Sur y otro para Norte. Este servicio atiende SOLO
 * los consultorios ruteados a CalDAV (calendarRouting — los que tienen
 * GOOGLE_CALENDAR_<SLUG> van a googleCalendarService). El mapeo viene de env
 * vars CALDAV_CALENDAR_<CONSULTORIO> (con CALDAV_CALENDAR_NAME como fallback
 * para setups de un solo calendario). Las citas se crean en el calendario del
 * consultorio elegido; la disponibilidad la lee calendarService fusionando
 * todos los proveedores (bloqueo global).
 *
 * Resiliencia por calendario (fix del E2E 21/08): un calendario mal
 * configurado o caído NO tumba al resto — se loggea y se sigue con los
 * demás. Antes, un solo nombre no encontrado tiraba la sesión completa y la
 * disponibilidad degradaba a MySQL-only ignorando TODOS los bloqueos.
 *
 * La sesión (login + descubrimiento de calendarios) se hace una vez por
 * proceso y se cachea; si falla, la siguiente llamada reintenta desde cero.
 */

import { DAVClient } from 'tsdav';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { buildVEvent, parseCalendarObject } from '../lib/ics.js';
import { caldavLocations, caldavCalendarNameFor as calendarNameFor } from './calendarRouting.js';

const log = logger.child({ module: 'caldavService' });

// Consultorios que atiende este servicio (config congelada al boot).
const LOCATIONS = caldavLocations();

/**
 * ¿Está completa la configuración de CalDAV? Requiere credenciales y un
 * calendario resuelto para CADA consultorio ruteado a CalDAV. Permite a los
 * callers degradar limpio mientras falte algo. Con cero consultorios en
 * CalDAV (todo en Google), este servicio simplemente no aplica.
 *
 * @returns {boolean}
 */
export function isConfigured() {
  return (
    LOCATIONS.length > 0 &&
    Boolean(config.CALDAV_SERVER_URL) &&
    Boolean(config.CALDAV_USERNAME) &&
    Boolean(config.CALDAV_APP_SPECIFIC_PASSWORD) &&
    LOCATIONS.every((location) => Boolean(calendarNameFor(location)))
  );
}

/**
 * @type {Promise<{
 *   client: DAVClient,
 *   calendarsByLocation: Map<string, import('tsdav').DAVCalendar>,
 *   uniqueCalendars: import('tsdav').DAVCalendar[],
 * }> | null}
 */
let sessionPromise = null;

function getSession() {
  if (!sessionPromise) {
    sessionPromise = initSession().catch((err) => {
      // No cachear el fracaso: la siguiente llamada reintenta el login
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

async function initSession() {
  if (!isConfigured()) {
    const missingCreds = ['CALDAV_USERNAME', 'CALDAV_APP_SPECIFIC_PASSWORD'].filter(
      (key) => !config[key],
    );
    const missingCalendars = LOCATIONS.filter((loc) => !calendarNameFor(loc)).map(
      (loc) => `CALDAV_CALENDAR_${loc.toUpperCase()}`,
    );
    throw new Error(
      `CalDAV no configurado — faltan env vars: ${[...missingCreds, ...missingCalendars].join(', ')}`,
    );
  }

  const client = new DAVClient({
    serverUrl: config.CALDAV_SERVER_URL,
    credentials: {
      username: config.CALDAV_USERNAME,
      password: config.CALDAV_APP_SPECIFIC_PASSWORD,
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });

  await client.login();
  const calendars = await client.fetchCalendars();

  // Un calendario no encontrado NO tira la sesión: se registra como faltante
  // (ping lo reporta, createEvent hacia él falla con error claro) y el resto
  // sigue operando — sobre todo el bloqueo de disponibilidad de los sanos.
  const calendarsByLocation = new Map();
  const missingByLocation = new Map();
  for (const location of LOCATIONS) {
    const wanted = calendarNameFor(location).trim().toLowerCase();
    const calendar = calendars.find(
      (c) => displayNameOf(c).trim().toLowerCase() === wanted,
    );
    if (!calendar) {
      const available = calendars.map(displayNameOf).filter(Boolean);
      missingByLocation.set(location, calendarNameFor(location));
      log.error(
        { location, wanted: calendarNameFor(location), available },
        'CalDAV: calendario configurado no existe en la cuenta — ese consultorio queda sin calendario (los demás siguen)',
      );
      continue;
    }
    calendarsByLocation.set(location, calendar);
  }

  // Con fallback a un solo calendario, varios consultorios comparten el
  // mismo — dedupe por URL para no leerlo dos veces en listEvents.
  const uniqueCalendars = [
    ...new Map([...calendarsByLocation.values()].map((c) => [c.url, c])).values(),
  ];

  log.info(
    {
      calendars: Object.fromEntries(
        [...calendarsByLocation].map(([loc, c]) => [loc, displayNameOf(c)]),
      ),
      missing: Object.fromEntries(missingByLocation),
    },
    'Sesión CalDAV inicializada',
  );
  return { client, calendarsByLocation, missingByLocation, uniqueCalendars };
}

// tsdav puede devolver displayName como string u objeto vacío según el server
function displayNameOf(calendar) {
  return typeof calendar.displayName === 'string' ? calendar.displayName : '';
}

/**
 * Lista eventos de TODOS los calendarios configurados que se TRASLAPAN con
 * el rango [from, to] (bloqueo global entre consultorios). Pide al servidor
 * expandir recurrencias; si el server no soporta expand, reintenta sin él
 * (los recurrentes viejos se pierden — se loggea warning).
 *
 * @param {{ from: Date, to: Date }} args
 * @returns {Promise<Array<{ uid: string|null, summary: string|null, location: string|null, start: Date, end: Date, allDay: boolean }>>}
 */
export async function listEvents({ from, to }) {
  const { client, uniqueCalendars } = await getSession();
  const timeRange = { start: from.toISOString(), end: to.toISOString() };

  // Resiliencia por calendario: si uno falla (server hiccup, permisos), se
  // loggea y se sigue con los demás — un calendario caído no debe anular el
  // bloqueo de disponibilidad de los otros.
  const perCalendar = await Promise.all(
    uniqueCalendars.map(async (calendar) => {
      try {
        try {
          return await client.fetchCalendarObjects({ calendar, timeRange, expand: true });
        } catch (err) {
          log.warn(
            { err: err.message, calendar: displayNameOf(calendar) },
            'calendar-query con expand falló; reintentando sin expandir recurrencias',
          );
          return await client.fetchCalendarObjects({ calendar, timeRange });
        }
      } catch (err) {
        log.error(
          { err, calendar: displayNameOf(calendar) },
          'CalDAV: no se pudieron leer eventos de este calendario — se continúa con los demás',
        );
        return [];
      }
    }),
  );

  const events = perCalendar
    .flat()
    .flatMap((obj) => parseCalendarObject(obj.data))
    // El server filtra por timeRange, pero re-filtramos por traslape real:
    // con expand pueden venir ocurrencias de más, y sin expand el VEVENT
    // maestro puede tener fechas fuera del rango pedido.
    .filter((e) => e.start < to && e.end > from);

  log.debug({ from, to, count: events.length }, 'listEvents');
  return events;
}

/**
 * Crea un evento EN EL CALENDARIO DEL CONSULTORIO indicado y devuelve su UID
 * (se guarda en appointments.caldav_event_uid para poder borrarlo al
 * cancelar/reagendar).
 *
 * @param {{ summary: string, start: Date, end: Date, location: string, description?: string }} args
 * @returns {Promise<{ uid: string }>}
 */
export async function createEvent({ summary, start, end, description, location }) {
  const { client, calendarsByLocation, missingByLocation } = await getSession();

  const calendar = calendarsByLocation.get(location);
  if (!calendar) {
    const missing = missingByLocation.get(location);
    throw new Error(
      missing
        ? `CalDAV createEvent: el calendario "${missing}" (consultorio ${location}) no existe en la cuenta`
        : `CalDAV createEvent: consultorio desconocido "${location}" (configurados: ${LOCATIONS.join(', ')})`,
    );
  }

  const uid = crypto.randomUUID();
  const iCalString = buildVEvent({ uid, start, end, summary, description, location });

  // filename = `${uid}.ics` fija el href del objeto: deleteEvent lo
  // reconstruye desde el UID sin necesitar guardar la URL completa en DB.
  const response = await client.createCalendarObject({
    calendar,
    filename: `${uid}.ics`,
    iCalString,
  });
  if (!response.ok) {
    throw new Error(`CalDAV createEvent falló: HTTP ${response.status} ${response.statusText}`);
  }

  log.info(
    { uid, summary, start, end, location, calendar: displayNameOf(calendar) },
    'createEvent',
  );
  return { uid };
}

/**
 * Busca un evento por UID (sincronización con cambios manuales de la doctora
 * — calendarSync). Mismo orden que deleteEvent: primero el calendario del
 * consultorio, luego el resto; el href es `{uid}.ics` (convención de
 * createEvent).
 *
 * "missing" solo se reporta cuando es DEFINITIVO: el objeto da 404 en todos
 * los calendarios Y cada calendario responde (existe y es accesible). Un
 * calendario faltante en la config o que no responde lanza — sin eso, perder
 * acceso a un calendario haría parecer borradas todas sus citas.
 *
 * @param {{ uid: string, location?: string }} args
 * @returns {Promise<{ status: 'found', start: Date, end: Date, allDay: boolean } | { status: 'missing' }>}
 */
export async function getEvent({ uid, location }) {
  const { calendarsByLocation, missingByLocation, uniqueCalendars } = await getSession();
  if (missingByLocation.size > 0) {
    throw new Error(
      `CalDAV getEvent: hay calendarios configurados que no existen (${[...missingByLocation.values()].join(', ')}) — no se puede asegurar que el evento no exista`,
    );
  }

  const preferred = location ? calendarsByLocation.get(location) : null;
  const candidates = preferred
    ? [preferred, ...uniqueCalendars.filter((c) => c.url !== preferred.url)]
    : uniqueCalendars;
  if (candidates.length === 0) throw new Error('CalDAV getEvent: sin calendarios en la sesión');

  for (const calendar of candidates) {
    const base = calendar.url.endsWith('/') ? calendar.url : `${calendar.url}/`;
    const response = await fetch(`${base}${uid}.ics`, {
      headers: { Authorization: basicAuthHeader(), Accept: 'text/calendar' },
    });

    if (response.status === 404) {
      await assertCollectionReachable(calendar);
      continue;
    }
    if (!response.ok) {
      throw new Error(`CalDAV getEvent falló: HTTP ${response.status} ${response.statusText}`);
    }

    const events = parseCalendarObject(await response.text());
    const event = events.find((e) => e.uid === uid) ?? events[0];
    if (!event) {
      // Existe pero no se puede leer como bloqueo (cancelado/transparente o
      // formato raro): no es un borrado — el caller lo trata como no verificable.
      throw new Error(`CalDAV getEvent: el objeto ${uid}.ics existe pero no trae un VEVENT utilizable`);
    }
    return { status: 'found', start: event.start, end: event.end, allDay: event.allDay };
  }

  return { status: 'missing' };
}

function basicAuthHeader() {
  const token = Buffer.from(`${config.CALDAV_USERNAME}:${config.CALDAV_APP_SPECIFIC_PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}

// Un 404 del objeto solo significa "no existe" si la colección (el
// calendario) sí responde. PROPFIND Depth 0 = "¿existe este calendario?".
// Se cachea unos minutos para no repetirlo por cada cita del barrido diario.
const COLLECTION_CHECK_TTL_MS = 5 * 60 * 1000;
const collectionCheckedAt = new Map(); // calendar.url → timestamp

async function assertCollectionReachable(calendar) {
  const last = collectionCheckedAt.get(calendar.url) ?? 0;
  if (Date.now() - last < COLLECTION_CHECK_TTL_MS) return;

  const response = await fetch(calendar.url, {
    method: 'PROPFIND',
    headers: {
      Authorization: basicAuthHeader(),
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
  });
  if (response.status !== 207 && !response.ok) {
    throw new Error(
      `CalDAV: el calendario "${displayNameOf(calendar)}" no responde (HTTP ${response.status}) — no se puede asegurar que el evento no exista`,
    );
  }
  collectionCheckedAt.set(calendar.url, Date.now());
}

/**
 * Borra un evento por UID. Busca primero en el calendario del consultorio
 * indicado y, si no está (404), en el resto — cubre citas creadas cuando el
 * mapeo de calendarios era distinto. Devuelve ok:false si no existe en
 * ninguno (ej. la doctora ya lo borró a mano) — para el caller no es error.
 *
 * @param {{ uid: string, location?: string }} args
 * @returns {Promise<{ ok: boolean }>}
 */
export async function deleteEvent({ uid, location }) {
  const { client, calendarsByLocation, uniqueCalendars } = await getSession();

  const preferred = location ? calendarsByLocation.get(location) : null;
  const candidates = preferred
    ? [preferred, ...uniqueCalendars.filter((c) => c.url !== preferred.url)]
    : uniqueCalendars;

  for (const calendar of candidates) {
    const base = calendar.url.endsWith('/') ? calendar.url : `${calendar.url}/`;
    const response = await client.deleteCalendarObject({
      calendarObject: { url: `${base}${uid}.ics` },
    });

    if (response.status === 404) continue;
    if (!response.ok) {
      throw new Error(`CalDAV deleteEvent falló: HTTP ${response.status} ${response.statusText}`);
    }

    log.info({ uid, calendar: displayNameOf(calendar) }, 'deleteEvent');
    return { ok: true };
  }

  log.warn({ uid, location }, 'deleteEvent: el evento no existe en ningún calendario');
  return { ok: false };
}

/**
 * Verifica conectividad y que todos los calendarios configurados existan.
 * Pensado para el health check de arranque y el smoke test. Con calendarios
 * faltantes devuelve ok:false pero incluye los que SÍ se encontraron (la
 * sesión queda operando en modo parcial).
 *
 * @returns {Promise<{ ok: boolean, calendars?: Record<string, string>, error?: string }>}
 */
export async function ping() {
  try {
    const { calendarsByLocation, missingByLocation } = await getSession();
    const calendars = Object.fromEntries(
      [...calendarsByLocation].map(([loc, c]) => [loc, displayNameOf(c)]),
    );
    if (missingByLocation.size > 0) {
      const detail = [...missingByLocation]
        .map(([loc, name]) => `"${name}" (${loc})`)
        .join(', ');
      return { ok: false, calendars, error: `CalDAV: calendarios no encontrados: ${detail}` };
    }
    return { ok: true, calendars };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
