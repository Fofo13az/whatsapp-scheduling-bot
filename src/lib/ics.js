/**
 * Utilidades iCalendar (RFC 5545) — módulo puro, sin I/O.
 *
 * Cubre exactamente lo que el bot necesita de CalDAV:
 *   - buildVEvent: generar el VCALENDAR/VEVENT de una cita para subir a iCloud.
 *   - parseCalendarObject: extraer los VEVENT de un objeto que iCloud devuelve,
 *     con fechas ya resueltas a instantes UTC.
 *
 * No es un parser general de iCalendar: ignora VTODO, VJOURNAL, alarmas y
 * attachments. Para RRULE (eventos recurrentes) dependemos de que el servidor
 * expanda las ocurrencias (calendar-query con expand); si el servidor no
 * expande, el evento maestro se parsea con su fecha original y el caller lo
 * descarta por estar fuera de rango.
 */

import { wallTimeToUtc, MS_PER_MINUTE } from './dates.js';

const CRLF = '\r\n';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Generación ──────────────────────────────────────────────────────────────

/**
 * Construye un VCALENDAR completo con un solo VEVENT, listo para subir vía
 * createCalendarObject. Fechas en UTC (formato ...Z) — sin VTIMEZONE, que
 * iCloud acepta y muestra en la zona local del usuario.
 *
 * @param {{ uid: string, start: Date, end: Date, summary: string, description?: string, location?: string }} args
 * @returns {string}
 */
export function buildVEvent({ uid, start, end, summary, description, location }) {
  if (!uid || !(start instanceof Date) || !(end instanceof Date) || !summary) {
    throw new Error('buildVEvent: uid, start, end y summary son obligatorios');
  }
  if (end <= start) {
    throw new Error('buildVEvent: end debe ser posterior a start');
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Scheduling Bot//Citas WhatsApp//ES',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatIcsUtc(new Date())}`,
    `DTSTART:${formatIcsUtc(start)}`,
    `DTEND:${formatIcsUtc(end)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
  ];
  if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
  if (description) lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');

  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}

/**
 * Instante UTC → "20260708T160000Z".
 * @param {Date} date
 * @returns {string}
 */
export function formatIcsUtc(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// Texto en propiedades iCalendar: escapar \ ; , y saltos de línea (RFC 5545 §3.3.11).
function escapeIcsText(text) {
  return String(text)
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll(/\r?\n/g, '\\n');
}

// RFC 5545 §3.1: líneas de máx 75 octetos; continuación = CRLF + espacio.
// Cortamos por codepoints como aproximación (un corte a mitad de un carácter
// multibyte rompería el UTF-8).
function foldIcsLine(line) {
  const chars = Array.from(line);
  if (chars.length <= 74) return line;
  const chunks = [];
  for (let i = 0; i < chars.length; i += 74) {
    chunks.push(chars.slice(i, i + 74).join(''));
  }
  return chunks.join(`${CRLF} `);
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parsea el string ICS de un objeto de calendario y devuelve sus VEVENT como
 * eventos con fechas UTC resueltas.
 *
 * Se omiten eventos cancelados (STATUS:CANCELLED) y transparentes
 * (TRANSP:TRANSPARENT — el usuario los marcó como "disponible", no bloquean).
 *
 * @param {string} icsString
 * @param {{ defaultTimeZone?: string }} [opts]  Zona para fechas "flotantes" (sin Z ni TZID)
 * @returns {Array<{ uid: string|null, summary: string|null, location: string|null, start: Date, end: Date, allDay: boolean }>}
 */
export function parseCalendarObject(icsString, { defaultTimeZone } = {}) {
  const lines = unfoldIcsLines(icsString ?? '');
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) {
        const event = finalizeEvent(current, defaultTimeZone);
        if (event) events.push(event);
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const prop = parseIcsProperty(line);
    if (!prop) continue;
    // VALARM y otros sub-componentes traen sus propias propiedades; las
    // llaves que nos interesan solo aparecen a nivel VEVENT, y un SUMMARY
    // de alarma pisaría el del evento — por eso "primero gana".
    if (!(prop.name in current)) current[prop.name] = prop;
  }

  return events;
}

function finalizeEvent(props, defaultTimeZone) {
  const status = props.STATUS?.value?.toUpperCase();
  if (status === 'CANCELLED') return null;
  const transp = props.TRANSP?.value?.toUpperCase();
  if (transp === 'TRANSPARENT') return null;

  const dtstart = props.DTSTART ? parseIcsDate(props.DTSTART, defaultTimeZone) : null;
  if (!dtstart) return null;

  let end = props.DTEND ? parseIcsDate(props.DTEND, defaultTimeZone)?.date : null;
  if (!end && props.DURATION) {
    const durationMs = parseIcsDuration(props.DURATION.value);
    if (durationMs != null) end = new Date(dtstart.date.getTime() + durationMs);
  }
  if (!end) {
    // RFC 5545 §3.6.1: sin DTEND ni DURATION, un evento all-day dura un día
    // y uno con hora no ocupa tiempo (lo tratamos igual, no bloquea nada).
    end = dtstart.allDay ? new Date(dtstart.date.getTime() + MS_PER_DAY) : dtstart.date;
  }

  return {
    uid: props.UID?.value ?? null,
    summary: props.SUMMARY ? unescapeIcsText(props.SUMMARY.value) : null,
    location: props.LOCATION ? unescapeIcsText(props.LOCATION.value) : null,
    start: dtstart.date,
    end,
    allDay: dtstart.allDay,
  };
}

// Deshace el folding: una línea que empieza con espacio o tab continúa la anterior.
function unfoldIcsLines(icsString) {
  const rawLines = icsString.split(/\r?\n/);
  const lines = [];
  for (const raw of rawLines) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
    } else if (raw.length > 0) {
      lines.push(raw);
    }
  }
  return lines;
}

/**
 * "DTSTART;TZID=America/Mexico_City:20260708T100000" →
 * { name: 'DTSTART', params: { TZID: 'America/Mexico_City' }, value: '20260708T100000' }
 */
function parseIcsProperty(line) {
  // El ":" que separa nombre+params del valor no puede estar dentro de comillas
  let splitAt = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      splitAt = i;
      break;
    }
  }
  if (splitAt === -1) return null;

  const [name, ...paramParts] = line.slice(0, splitAt).split(';');
  const params = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).toUpperCase();
    params[key] = part.slice(eq + 1).replaceAll('"', '');
  }

  return { name: name.toUpperCase(), params, value: line.slice(splitAt + 1) };
}

function unescapeIcsText(value) {
  return String(value ?? '')
    .replaceAll('\\n', '\n')
    .replaceAll('\\N', '\n')
    .replaceAll('\\,', ',')
    .replaceAll('\\;', ';')
    .replaceAll('\\\\', '\\');
}

/**
 * Resuelve un valor DATE o DATE-TIME de iCalendar a instante UTC.
 * Formatos: "20260708T160000Z" (UTC), "20260708T100000" con/sin TZID
 * (hora de pared), "20260708" (all-day).
 *
 * @returns {{ date: Date, allDay: boolean } | null}
 */
function parseIcsDate(prop, defaultTimeZone) {
  const value = prop.value.trim();

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly || prop.params.VALUE === 'DATE') {
    const m = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!m) return null;
    // All-day: medianoche en la zona del consultorio — un día bloqueado por
    // la doctora debe bloquear el día del consultorio, no el día UTC.
    const date = safeWallTimeToUtc(
      { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) },
      defaultTimeZone,
    );
    return { date, allDay: true };
  }

  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!dateTime) return null;

  const parts = {
    year: Number(dateTime[1]),
    month: Number(dateTime[2]),
    day: Number(dateTime[3]),
    hour: Number(dateTime[4]),
    minute: Number(dateTime[5]),
    second: Number(dateTime[6]),
  };

  if (dateTime[7] === 'Z') {
    return {
      date: new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)),
      allDay: false,
    };
  }

  // Hora de pared: con TZID explícito, o "flotante" (se asume la zona default)
  return { date: safeWallTimeToUtc(parts, prop.params.TZID ?? defaultTimeZone), allDay: false };
}

// TZIDs no-IANA (ej. los "custom" de Outlook) truenan en Intl → caer a la
// zona del consultorio en lugar de perder el evento completo.
function safeWallTimeToUtc(parts, timeZone) {
  if (timeZone) {
    try {
      return wallTimeToUtc(parts, timeZone);
    } catch {
      // cae al default de wallTimeToUtc (zona del consultorio)
    }
  }
  return wallTimeToUtc(parts);
}

/**
 * Duración ISO 8601 restringida a lo que usa iCalendar: "PT45M", "PT1H30M",
 * "P1D". Devuelve milisegundos o null si no parsea.
 */
function parseIcsDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    String(value ?? '').trim(),
  );
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const [weeks, days, hours, minutes, seconds] = [m[2], m[3], m[4], m[5], m[6]].map(
    (v) => Number(v ?? 0),
  );
  return (
    sign *
    (weeks * 7 * MS_PER_DAY +
      days * MS_PER_DAY +
      hours * 60 * MS_PER_MINUTE +
      minutes * MS_PER_MINUTE +
      seconds * 1000)
  );
}
