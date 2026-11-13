/**
 * googleCalendarService — integración con Google Calendar (API v3, REST).
 *
 * Surge del E2E del 21/08: el calendario de Sur vive en la cuenta de
 * GOOGLE de la doctora (compartido con su secretaria, que agenda desde
 * Android vía Google Calendar) y el CalDAV de iCloud no puede verlo.
 *
 * Autenticación: **service account** de Google Cloud, sin OAuth de usuario —
 * la doctora comparte su calendario con el email de la service account
 * (permiso "Hacer cambios en eventos") y el bot firma un JWT RS256 con la
 * llave privada para canjear access tokens. Sin dependencias nuevas: el JWT
 * se firma con node:crypto y las llamadas van con fetch nativo.
 *
 * Mismo contrato que caldavService (listEvents, createEvent, deleteEvent,
 * ping, isConfigured); calendarService rutea cada consultorio a su proveedor.
 * Semántica de eventos alineada con el parser de ICS:
 *   - all-day bloquea el día completo en hora del consultorio
 *   - cancelados y "transparentes" (mostrar como disponible) no bloquean
 *
 * Docs: https://developers.google.com/calendar/api/v3/reference
 */

import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { clinicTimeToUtc } from '../lib/dates.js';
import { googleLocations, googleCalendarIdFor } from './calendarRouting.js';

const log = logger.child({ module: 'googleCalendarService' });

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar';

// Consultorios que atiende este servicio (config congelada al boot).
const LOCATIONS = googleLocations();

/**
 * ¿Está completa la configuración? Requiere la service account y al menos un
 * consultorio ruteado a Google (GOOGLE_CALENDAR_<SLUG>).
 *
 * @returns {boolean}
 */
export function isConfigured() {
  return (
    LOCATIONS.length > 0 &&
    Boolean(config.GOOGLE_SA_EMAIL) &&
    Boolean(config.GOOGLE_SA_PRIVATE_KEY)
  );
}

/** IDs únicos de calendario (varios consultorios pueden compartir uno). */
function uniqueCalendarIds() {
  return [...new Set(LOCATIONS.map(googleCalendarIdFor))];
}

// ─── Access token (JWT de service account) ──────────────────────────────────

let tokenCache = null; // { accessToken, expiresAtMs }

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** La llave viaja en env var con los saltos de línea escapados como "\n". */
function privateKeyPem() {
  return config.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, '\n');
}

async function getAccessToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAtMs) {
    return tokenCache.accessToken;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: config.GOOGLE_SA_EMAIL,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSec - 30, // colchón por clock skew
    exp: nowSec + 3600,
  }));
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(privateKeyPem())
    .toString('base64url');
  const assertion = `${header}.${claims}.${signature}`;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `Google token falló: HTTP ${response.status} — ${data?.error_description ?? data?.error ?? 'sin detalle'}`,
    );
  }

  tokenCache = {
    accessToken: data.access_token,
    // Renovar 60s antes de que expire (default: 3600s).
    expiresAtMs: Date.now() + (data.expires_in - 60) * 1000,
  };
  return tokenCache.accessToken;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/**
 * Llamada autenticada a la API. Devuelve el JSON (o null en 204). Lanza con
 * el mensaje de Google en errores; el 404/410 de DELETE lo maneja el caller
 * vía err.googleStatus.
 */
async function apiFetch(path, { method = 'GET', query, body } = {}) {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });

  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(
      `Google Calendar API ${method} ${path}: HTTP ${response.status} — ${data?.error?.message ?? 'sin detalle'}`,
    );
    err.googleStatus = response.status;
    throw err;
  }
  return data;
}

// ─── API pública (contrato de calendarService) ──────────────────────────────

/**
 * Lista eventos de TODOS los calendarios de Google configurados que se
 * traslapan con [from, to]. Recurrencias expandidas por el server
 * (singleEvents). Resiliencia por calendario: uno caído se loggea y se sigue
 * con los demás.
 *
 * @param {{ from: Date, to: Date }} args
 * @returns {Promise<Array<{ uid: string|null, summary: string|null, location: string|null, start: Date, end: Date, allDay: boolean }>>}
 */
export async function listEvents({ from, to }) {
  const perCalendar = await Promise.all(
    uniqueCalendarIds().map(async (calendarId) => {
      try {
        return await listCalendarEvents(calendarId, from, to);
      } catch (err) {
        log.error(
          { err, calendarId },
          'Google: no se pudieron leer eventos de este calendario — se continúa con los demás',
        );
        return [];
      }
    }),
  );

  const events = perCalendar.flat().filter((e) => e.start < to && e.end > from);
  log.debug({ from, to, count: events.length }, 'listEvents');
  return events;
}

async function listCalendarEvents(calendarId, from, to) {
  const events = [];
  let pageToken;
  do {
    const data = await apiFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      query: {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: 'true',
        maxResults: '2500',
        ...(pageToken && { pageToken }),
      },
    });
    for (const item of data.items ?? []) {
      const event = mapEvent(item);
      if (event) events.push(event);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return events;
}

/**
 * Google → shape interno. Devuelve null para eventos que no bloquean:
 * cancelados y transparentes ("Mostrar como: Disponible" en Google Calendar
 * — el equivalente del TRANSP:TRANSPARENT que ya respetamos en iCloud).
 */
function mapEvent(item) {
  if (item.status === 'cancelled') return null;
  if (item.transparency === 'transparent') return null;

  const times = eventTimes(item);
  if (!times) return null;

  return {
    uid: item.id ?? null,
    summary: item.summary ?? null,
    location: item.location ?? null,
    ...times,
  };
}

/** Inicio/fin UTC de un evento de Google (null si no se pueden leer). */
function eventTimes(item) {
  const allDay = !item.start?.dateTime;
  let start;
  let end;
  if (allDay) {
    // All-day: "YYYY-MM-DD" (end exclusivo) → día completo en hora del
    // consultorio, igual que los all-day de iCloud (lib/ics.js).
    if (!item.start?.date || !item.end?.date) return null;
    start = clinicTimeToUtc(parseDateOnly(item.start.date));
    end = clinicTimeToUtc(parseDateOnly(item.end.date));
  } else {
    start = new Date(item.start.dateTime);
    end = new Date(item.end?.dateTime ?? item.start.dateTime);
  }
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start, end, allDay };
}

function parseDateOnly(str) {
  const [year, month, day] = String(str).split('-').map(Number);
  return { year, month, day, hour: 0, minute: 0 };
}

/**
 * Crea un evento en el calendario de Google del consultorio indicado.
 *
 * @param {{ summary: string, start: Date, end: Date, location: string, description?: string }} args
 * @returns {Promise<{ uid: string }>}  El id del evento (se guarda en
 *   appointments.caldav_event_uid, igual que los UID de iCloud)
 */
export async function createEvent({ summary, start, end, description, location }) {
  const calendarId = googleCalendarIdFor(location);
  if (!calendarId) {
    throw new Error(
      `Google createEvent: consultorio "${location}" sin GOOGLE_CALENDAR_* (configurados: ${LOCATIONS.join(', ')})`,
    );
  }

  const data = await apiFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: {
      summary,
      ...(description && { description }),
      start: { dateTime: start.toISOString(), timeZone: 'UTC' },
      end: { dateTime: end.toISOString(), timeZone: 'UTC' },
    },
  });

  log.info({ uid: data.id, summary, start, end, location, calendarId }, 'createEvent');
  return { uid: data.id };
}

/**
 * Busca un evento por id (sincronización con cambios manuales — calendarSync).
 * Mismo orden que deleteEvent. Un evento borrado en Google sigue existiendo
 * un tiempo con status "cancelled" (luego da 404/410): ambos cuentan como "no
 * está en este calendario".
 *
 * "missing" solo si es DEFINITIVO: además del 404 del evento, el calendario
 * debe responder — la API también da 404 cuando la service account perdió
 * acceso al calendario, y eso NO debe parecer que se borraron sus citas.
 *
 * @param {{ uid: string, location?: string }} args
 * @returns {Promise<{ status: 'found', start: Date, end: Date, allDay: boolean } | { status: 'missing' }>}
 */
export async function getEvent({ uid, location }) {
  const preferred = location ? googleCalendarIdFor(location) : null;
  const candidates = preferred
    ? [preferred, ...uniqueCalendarIds().filter((id) => id !== preferred)]
    : uniqueCalendarIds();
  if (candidates.length === 0) throw new Error('Google getEvent: sin calendarios configurados');

  for (const calendarId of candidates) {
    let item;
    try {
      item = await apiFetch(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(uid)}`,
      );
    } catch (err) {
      if (err.googleStatus !== 404 && err.googleStatus !== 410) throw err;
      await assertCalendarReachable(calendarId);
      continue;
    }

    if (item.status === 'cancelled') continue;

    const times = eventTimes(item);
    if (!times) throw new Error(`Google getEvent: el evento ${uid} existe pero sin fechas legibles`);
    return { status: 'found', ...times };
  }

  return { status: 'missing' };
}

// Cacheado unos minutos: el barrido diario revisa muchas citas seguidas.
const CALENDAR_CHECK_TTL_MS = 5 * 60 * 1000;
const calendarCheckedAt = new Map(); // calendarId → timestamp

async function assertCalendarReachable(calendarId) {
  const last = calendarCheckedAt.get(calendarId) ?? 0;
  if (Date.now() - last < CALENDAR_CHECK_TTL_MS) return;

  try {
    await apiFetch(`/calendars/${encodeURIComponent(calendarId)}`);
  } catch (err) {
    throw new Error(
      `Google: el calendario "${calendarId}" no responde (${err.message}) — no se puede asegurar que el evento no exista`,
    );
  }
  calendarCheckedAt.set(calendarId, Date.now());
}

/**
 * Borra un evento por id. Busca primero en el calendario del consultorio
 * indicado y luego en el resto. Devuelve ok:false si no existe en ninguno
 * (ej. la doctora o la secretaria ya lo borraron a mano) — no es error.
 *
 * @param {{ uid: string, location?: string }} args
 * @returns {Promise<{ ok: boolean }>}
 */
export async function deleteEvent({ uid, location }) {
  const preferred = location ? googleCalendarIdFor(location) : null;
  const candidates = preferred
    ? [preferred, ...uniqueCalendarIds().filter((id) => id !== preferred)]
    : uniqueCalendarIds();

  for (const calendarId of candidates) {
    try {
      await apiFetch(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(uid)}`,
        { method: 'DELETE' },
      );
      log.info({ uid, calendarId }, 'deleteEvent');
      return { ok: true };
    } catch (err) {
      // 404 = no está en este calendario; 410 = ya estaba borrado (cuenta
      // como éxito: el objetivo era que no exista).
      if (err.googleStatus === 404) continue;
      if (err.googleStatus === 410) {
        log.info({ uid, calendarId }, 'deleteEvent: el evento ya estaba borrado');
        return { ok: true };
      }
      throw err;
    }
  }

  log.warn({ uid, location }, 'deleteEvent: el evento no existe en ningún calendario de Google');
  return { ok: false };
}

/**
 * Verifica credenciales y acceso a cada calendario configurado (la doctora
 * debe haberlos compartido con el email de la service account).
 *
 * @returns {Promise<{ ok: boolean, calendars?: Record<string, string>, error?: string }>}
 */
export async function ping() {
  try {
    const calendars = {};
    const failures = [];
    for (const location of LOCATIONS) {
      const calendarId = googleCalendarIdFor(location);
      try {
        const data = await apiFetch(`/calendars/${encodeURIComponent(calendarId)}`);
        calendars[location] = data.summary ?? calendarId;
      } catch (err) {
        failures.push(`"${calendarId}" (${location}): ${err.message}`);
      }
    }
    if (failures.length > 0) {
      return {
        ok: false,
        calendars,
        error:
          `Google: calendarios inaccesibles (¿compartidos con ${config.GOOGLE_SA_EMAIL}?): ` +
          failures.join('; '),
      };
    }
    return { ok: true, calendars };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
