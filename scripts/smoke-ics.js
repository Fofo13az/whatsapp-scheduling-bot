/**
 * Smoke test ad-hoc para src/lib/ics.js (build + parse de iCalendar) y las
 * utilidades genéricas de zona horaria. NO COMMITEAR (.gitignore).
 *
 * Corre sin credenciales ni red: todo es puro.
 *
 * Uso: node scripts/smoke-ics.js
 */

import 'dotenv/config';
import { buildVEvent, parseCalendarObject, formatIcsUtc } from '../src/lib/ics.js';
import { wallTimeToUtc } from '../src/lib/dates.js';

let passed = 0;
let failed = 0;

function expectEqual(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name} — esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
  }
}

function expectTrue(name, actual) {
  expectEqual(name, Boolean(actual), true);
}

function expectThrows(name, fn) {
  try {
    fn();
    failed += 1;
    console.log(`  ✗ ${name} — se esperaba un Error y no lanzó`);
  } catch {
    passed += 1;
    console.log(`  ✓ ${name}`);
  }
}

// ─── dates: wallTimeToUtc genérico ───────────────────────────────────────────
console.log('\n── wallTimeToUtc ──');

expectEqual(
  'CDMX (default) 10:00 → 16:00Z',
  wallTimeToUtc({ year: 2026, month: 7, day: 8, hour: 10 }).toISOString(),
  '2026-07-08T16:00:00.000Z',
);
expectEqual(
  'New York con DST (jul, UTC-4) 12:00 → 16:00Z',
  wallTimeToUtc({ year: 2026, month: 7, day: 8, hour: 12 }, 'America/New_York').toISOString(),
  '2026-07-08T16:00:00.000Z',
);
expectEqual(
  'New York sin DST (ene, UTC-5) 12:00 → 17:00Z',
  wallTimeToUtc({ year: 2026, month: 1, day: 8, hour: 12 }, 'America/New_York').toISOString(),
  '2026-01-08T17:00:00.000Z',
);

// ─── buildVEvent ─────────────────────────────────────────────────────────────
console.log('\n── buildVEvent ──');

const start = new Date('2026-07-08T16:00:00Z');
const end = new Date('2026-07-08T16:30:00Z');
const ics = buildVEvent({
  uid: 'test-uid-001',
  start,
  end,
  summary: 'Cita: María Pérez (rutinaria)',
  description: 'Notas; con, caracteres\nespeciales',
  location: 'Sur',
});

expectTrue('usa CRLF', ics.includes('\r\n'));
expectTrue('incluye UID', ics.includes('UID:test-uid-001'));
expectTrue('DTSTART en UTC', ics.includes('DTSTART:20260708T160000Z'));
expectTrue('DTEND en UTC', ics.includes('DTEND:20260708T163000Z'));
expectTrue('escapa ; y ,', ics.includes('DESCRIPTION:Notas\\; con\\, caracteres\\nespeciales'));
expectTrue('envuelve en VCALENDAR', ics.startsWith('BEGIN:VCALENDAR') && ics.trimEnd().endsWith('END:VCALENDAR'));

const longSummary = 'x'.repeat(200);
const folded = buildVEvent({ uid: 'u', start, end, summary: longSummary });
expectTrue(
  'foldea líneas largas a ≤75 chars',
  folded.split('\r\n').every((l) => Array.from(l).length <= 75),
);

expectThrows('end <= start lanza', () => buildVEvent({ uid: 'u', start, end: start, summary: 's' }));
expectThrows('sin summary lanza', () => buildVEvent({ uid: 'u', start, end }));

expectEqual('formatIcsUtc', formatIcsUtc(start), '20260708T160000Z');

// ─── roundtrip build → parse ─────────────────────────────────────────────────
console.log('\n── roundtrip ──');

const [roundtrip] = parseCalendarObject(ics);
expectEqual('uid', roundtrip.uid, 'test-uid-001');
expectEqual('summary (des-escapado)', roundtrip.summary, 'Cita: María Pérez (rutinaria)');
expectEqual('location', roundtrip.location, 'Sur');
expectEqual('start', roundtrip.start.toISOString(), '2026-07-08T16:00:00.000Z');
expectEqual('end', roundtrip.end.toISOString(), '2026-07-08T16:30:00.000Z');
expectEqual('allDay', roundtrip.allDay, false);

const [foldedBack] = parseCalendarObject(folded);
expectEqual('summary largo sobrevive el folding', foldedBack.summary, longSummary);

// ─── parse de formatos que manda iCloud ──────────────────────────────────────
console.log('\n── parse ──');

const wrap = (vevent) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n${vevent}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

// DTSTART con TZID (como guarda Apple Calendar los eventos con hora)
const [tzid] = parseCalendarObject(
  wrap('UID:e1\r\nDTSTART;TZID=America/Mexico_City:20260708T100000\r\nDTEND;TZID=America/Mexico_City:20260708T110000\r\nSUMMARY:Bloqueo'),
);
expectEqual('TZID CDMX 10:00 → 16:00Z', tzid.start.toISOString(), '2026-07-08T16:00:00.000Z');

// All-day (VALUE=DATE) — bloqueo de día completo de la doctora
const [allDay] = parseCalendarObject(
  wrap('UID:e2\r\nDTSTART;VALUE=DATE:20260708\r\nDTEND;VALUE=DATE:20260709\r\nSUMMARY:Vacaciones'),
);
expectEqual('all-day empieza a medianoche CDMX', allDay.start.toISOString(), '2026-07-08T06:00:00.000Z');
expectEqual('all-day termina a medianoche del día siguiente', allDay.end.toISOString(), '2026-07-09T06:00:00.000Z');
expectEqual('all-day flag', allDay.allDay, true);

// DURATION en lugar de DTEND
const [withDuration] = parseCalendarObject(
  wrap('UID:e3\r\nDTSTART:20260708T160000Z\r\nDURATION:PT1H30M\r\nSUMMARY:Junta'),
);
expectEqual('DURATION PT1H30M', withDuration.end.toISOString(), '2026-07-08T17:30:00.000Z');

// Eventos que NO deben bloquear
expectEqual(
  'STATUS:CANCELLED se omite',
  parseCalendarObject(wrap('UID:e4\r\nDTSTART:20260708T160000Z\r\nDTEND:20260708T170000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Cancelado')).length,
  0,
);
expectEqual(
  'TRANSP:TRANSPARENT se omite',
  parseCalendarObject(wrap('UID:e5\r\nDTSTART:20260708T160000Z\r\nDTEND:20260708T170000Z\r\nTRANSP:TRANSPARENT\r\nSUMMARY:Disponible')).length,
  0,
);

// El SUMMARY de un VALARM no debe pisar el del evento
const [withAlarm] = parseCalendarObject(
  wrap('UID:e6\r\nSUMMARY:Evento real\r\nDTSTART:20260708T160000Z\r\nDTEND:20260708T170000Z\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nSUMMARY:Alarma\r\nTRIGGER:-PT15M\r\nEND:VALARM'),
);
expectEqual('SUMMARY del VEVENT gana sobre el del VALARM', withAlarm.summary, 'Evento real');

// TZID desconocido no tira el parseo — cae a hora del consultorio
const [badTz] = parseCalendarObject(
  wrap('UID:e7\r\nDTSTART;TZID=Hora_Inventada:20260708T100000\r\nDTEND;TZID=Hora_Inventada:20260708T110000\r\nSUMMARY:Raro'),
);
expectEqual('TZID inválido cae a CDMX', badTz.start.toISOString(), '2026-07-08T16:00:00.000Z');

// Múltiples VEVENT en un solo objeto (recurrencias expandidas)
const multi = parseCalendarObject(
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:r1\r\nDTSTART:20260708T160000Z\r\nDTEND:20260708T170000Z\r\nSUMMARY:Ocurrencia 1\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:r1\r\nRECURRENCE-ID:20260715T160000Z\r\nDTSTART:20260715T160000Z\r\nDTEND:20260715T170000Z\r\nSUMMARY:Ocurrencia 2\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
);
expectEqual('dos ocurrencias expandidas', multi.length, 2);

// Basura no truena
expectEqual('string vacío → []', parseCalendarObject('').length, 0);
expectEqual('ICS sin VEVENT → []', parseCalendarObject('BEGIN:VCALENDAR\r\nEND:VCALENDAR').length, 0);

// ─── Resultado ───────────────────────────────────────────────────────────────
console.log(`\n${passed} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
