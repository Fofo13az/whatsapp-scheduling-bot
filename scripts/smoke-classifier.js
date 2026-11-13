/**
 * Smoke test ad-hoc para classifier + dates. NO COMMITEAR (.gitignore).
 *
 * Cubre los tres niveles de input (comando global, ID estructurado, texto
 * libre) por cada estado del flujo, y las utilidades de fecha/zona horaria.
 *
 * Uso: node scripts/smoke-classifier.js
 */

import 'dotenv/config';
import {
  matchGlobalCommand,
  classifyIdleIntent,
  classifyTypeSelection,
  classifyLocationSelection,
  classifyDateSelection,
  classifyTimeSelection,
  classifyName,
  classifyNotes,
  classifyConfirmation,
  classifyWaitlistPatient,
  isWaitlistCommand,
} from '../src/services/classifier.js';
import {
  clinicTimeToUtc,
  getClinicParts,
  formatDDMMYYYY,
  parseDDMMYYYY,
  parseHHMM,
  formatLongDateEs,
  formatShortDateEs,
} from '../src/lib/dates.js';

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

const text = (t) => ({ inputType: 'text', text: t, listId: null, buttonPayload: null });
const list = (id, title = '') => ({ inputType: 'list', text: title, listId: id, buttonPayload: null });
const button = (id, title = '') => ({ inputType: 'button', text: title, listId: null, buttonPayload: id });

// ─── dates ───────────────────────────────────────────────────────────────────
console.log('\n── dates ──');

// CDMX es UTC-6 fijo (sin DST desde 2022): 10:00 local = 16:00 UTC
const utc = clinicTimeToUtc({ year: 2026, month: 7, day: 8, hour: 10, minute: 0 });
expectEqual('clinicTimeToUtc 10:00 CDMX → 16:00Z', utc.toISOString(), '2026-07-08T16:00:00.000Z');

const roundtrip = getClinicParts(utc);
expectEqual('roundtrip parts', [roundtrip.year, roundtrip.month, roundtrip.day, roundtrip.hour, roundtrip.minute], [2026, 7, 8, 10, 0]);
expectEqual('weekday en inglés minúsculas', roundtrip.weekday, 'wednesday');

expectEqual('formatDDMMYYYY', formatDDMMYYYY({ year: 2026, month: 7, day: 8 }), '08/07/2026');
expectEqual('parseDDMMYYYY válida', parseDDMMYYYY('08/07/2026'), { year: 2026, month: 7, day: 8 });
expectEqual('parseDDMMYYYY rechaza 31/02', parseDDMMYYYY('31/02/2026'), null);
expectEqual('parseDDMMYYYY rechaza basura', parseDDMMYYYY('8/7/26'), null);
expectEqual('parseHHMM válida', parseHHMM('09:30'), { hour: 9, minute: 30 });
expectEqual('parseHHMM rechaza 25:00', parseHHMM('25:00'), null);

console.log(`  · label larga: "${formatLongDateEs(utc)}"`);
console.log(`  · label corta: "${formatShortDateEs(utc)}" (${Array.from(formatShortDateEs(utc)).length} chars, límite 24)`);
expectEqual('label corta ≤ 24 chars', Array.from(formatShortDateEs(utc)).length <= 24, true);

// ─── comandos globales ───────────────────────────────────────────────────────
console.log('\n── matchGlobalCommand ──');
expectEqual('cancelar', matchGlobalCommand('Cancelar'), 'cancel');
expectEqual('¡CANCELAR! con ruido', matchGlobalCommand('¡CANCELAR!'), 'cancel');
expectEqual('atrás con acento', matchGlobalCommand('atrás'), 'back');
expectEqual('regresar', matchGlobalCommand('regresar'), 'back');
expectEqual('ayuda', matchGlobalCommand('ayuda'), 'help');
expectEqual('frase larga NO es comando', matchGlobalCommand('quiero cancelar mi cita del martes'), null);
expectEqual('texto normal no matchea', matchGlobalCommand('hola'), null);

// ─── intents en IDLE ─────────────────────────────────────────────────────────
console.log('\n── classifyIdleIntent ──');
expectEqual('quiero una cita', classifyIdleIntent(text('Hola, quiero una cita')), 'schedule');
expectEqual('agendar', classifyIdleIntent(text('agendar')), 'schedule');
expectEqual('hola solo', classifyIdleIntent(text('hola!!')), 'greeting');
expectEqual('buenas tardes', classifyIdleIntent(text('Buenas tardes')), 'greeting');
expectEqual('cancelar mi cita', classifyIdleIntent(text('quiero cancelar mi cita')), 'cancel_appointment');
expectEqual('cambiar cita → reschedule', classifyIdleIntent(text('puedo cambiar mi cita?')), 'reschedule');
expectEqual('ayuda', classifyIdleIntent(text('necesito ayuda')), 'help');
expectEqual('texto random', classifyIdleIntent(text('asdfgh')), null);

// ─── SELECTING_TYPE ──────────────────────────────────────────────────────────
console.log('\n── classifyTypeSelection ──');
expectEqual('button type_primera_vez', classifyTypeSelection(button('type_primera_vez')), 'primera_vez');
expectEqual('list_reply type_subsecuente', classifyTypeSelection(list('type_subsecuente')), 'subsecuente');
expectEqual('list_reply id inválido', classifyTypeSelection(list('type_xyz')), null);
expectEqual('número "2"', classifyTypeSelection(text('2')), 'subsecuente');
expectEqual('número fuera de rango', classifyTypeSelection(text('9')), null);
expectEqual('keyword "primera"', classifyTypeSelection(text('es mi primera vez')), 'primera_vez');
expectEqual('keyword "subsecuente"', classifyTypeSelection(text('consulta subsecuente')), 'subsecuente');
expectEqual('keyword "seguimiento"', classifyTypeSelection(text('vengo a seguimiento')), 'subsecuente');
expectEqual('texto random', classifyTypeSelection(text('asdfgh')), null);

// ─── SELECTING_LOCATION ──────────────────────────────────────────────────────
console.log('\n── classifyLocationSelection ──');
expectEqual('button loc_sur', classifyLocationSelection(button('loc_sur')), 'sur');
expectEqual('button loc_norte', classifyLocationSelection(button('loc_norte')), 'norte');
expectEqual('número "1"', classifyLocationSelection(text('1')), 'norte');
expectEqual('texto "en norte"', classifyLocationSelection(text('en Norte porfa')), 'norte');
expectEqual('texto "norte"', classifyLocationSelection(text('en Norte porfa')), 'norte');
expectEqual('texto "del sur"', classifyLocationSelection(text('en la del sur')), 'sur');
expectEqual('texto random', classifyLocationSelection(text('en el centro')), null);

// ─── SELECTING_DATE ──────────────────────────────────────────────────────────
console.log('\n── classifyDateSelection ──');
const offeredDates = [
  { date: '08/07/2026', label: 'miércoles 8 de julio', shortLabel: 'Mié 8 jul' },
  { date: '10/07/2026', label: 'viernes 10 de julio', shortLabel: 'Vie 10 jul' },
];
expectEqual('list_reply date_...', classifyDateSelection(list('date_10/07/2026'), offeredDates), '10/07/2026');
expectEqual('list_reply fecha NO ofrecida', classifyDateSelection(list('date_25/12/2026'), offeredDates), null);
expectEqual('número "1"', classifyDateSelection(text('1'), offeredDates), '08/07/2026');
expectEqual('texto "08/07"', classifyDateSelection(text('el 08/07 porfa'), offeredDates), '08/07/2026');
expectEqual('texto "10/07/2026"', classifyDateSelection(text('10/07/2026'), offeredDates), '10/07/2026');
expectEqual('texto random', classifyDateSelection(text('mañana'), offeredDates), null);

// ─── SELECTING_TIME ──────────────────────────────────────────────────────────
console.log('\n── classifyTimeSelection ──');
const offeredSlots = ['09:00', '09:30', '10:00', '11:30'];
expectEqual('list_reply slot_...', classifyTimeSelection(list('slot_08/07/2026_10:00'), offeredSlots), '10:00');
expectEqual('list_reply slot NO ofrecido', classifyTimeSelection(list('slot_08/07/2026_15:00'), offeredSlots), null);
expectEqual('número "2"', classifyTimeSelection(text('2'), offeredSlots), '09:30');
expectEqual('texto "10:00"', classifyTimeSelection(text('10:00'), offeredSlots), '10:00');
expectEqual('texto "a las 10"', classifyTimeSelection(text('a las 10'), offeredSlots), '10:00');
expectEqual('texto "11 30"', classifyTimeSelection(text('11 30'), offeredSlots), '11:30');
expectEqual('hora no ofrecida', classifyTimeSelection(text('14:00'), offeredSlots), null);

// ─── COLLECTING_NAME ─────────────────────────────────────────────────────────
console.log('\n── classifyName ──');
expectEqual('nombre completo', classifyName(text('María Pérez López')), 'María Pérez López');
expectEqual('espacios extra', classifyName(text('  Ana   Gómez ')), 'Ana Gómez');
expectEqual('una sola palabra', classifyName(text('María')), null);
expectEqual('con números', classifyName(text('Maria 123')), null);
expectEqual('muy corto', classifyName(text('A B')), null);
expectEqual('input no textual', classifyName(button('confirm_yes')), null);

// ─── COLLECTING_NOTES ────────────────────────────────────────────────────────
console.log('\n── classifyNotes ──');
expectEqual('"no" → sin notas', classifyNotes(text('no')), { notes: null });
expectEqual('"Ninguna" → sin notas', classifyNotes(text('Ninguna')), { notes: null });
expectEqual('notas reales', classifyNotes(text('Tengo 8 semanas de embarazo')), { notes: 'Tengo 8 semanas de embarazo' });
expectEqual('input no textual → null', classifyNotes(list('date_08/07/2026')), null);

// ─── CONFIRMING ──────────────────────────────────────────────────────────────
console.log('\n── classifyConfirmation ──');
expectEqual('button confirm_yes', classifyConfirmation(button('confirm_yes')), 'yes');
expectEqual('button confirm_no', classifyConfirmation(button('confirm_no')), 'no');
expectEqual('button confirm_restart', classifyConfirmation(button('confirm_restart')), 'restart');
expectEqual('button ID viejo/ajeno', classifyConfirmation(button('type_embarazo')), null);
expectEqual('texto "sí"', classifyConfirmation(text('Sí')), 'yes');
expectEqual('texto "confirmo"', classifyConfirmation(text('confirmo')), 'yes');
expectEqual('texto "no"', classifyConfirmation(text('no')), 'no');
expectEqual('texto "de nuevo"', classifyConfirmation(text('de nuevo')), 'restart');
expectEqual('texto ambiguo', classifyConfirmation(text('mmm dejame pensarlo')), null);

// ─── Lista de espera: la doctora escribe un nombre (23/09) ───────────────────
console.log('\n── classifyWaitlistPatient ──');
const candidates = [
  { id: 'w1', patientName: 'Paola Martínez' },
  { id: 'w2', patientName: 'Ana López' },
  { id: 'w3', patientName: 'Ana López Pérez' },
  { id: 'w4', patientName: 'Manuela López' },
];
const pick = (t) => {
  const r = classifyWaitlistPatient(text(t), candidates);
  return r.kind === 'match' ? r.entry.id : r.kind === 'ambiguous' ? r.entries.map((e) => e.id) : null;
};
expectEqual('nombre completo con acento', pick('Paola Martínez'), 'w1');
expectEqual('solo nombre, sin acento', pick('paola'), 'w1');
expectEqual('prefijo de 3+ letras', pick('Pao'), 'w1');
expectEqual('número de la lista', pick('4'), 'w4');
expectEqual('número fuera de rango → nada', pick('9'), null);
expectEqual('exacto le gana a parcial', pick('ana lopez'), 'w2');
expectEqual('ambiguo → las que coinciden', pick('ana'), ['w2', 'w3']);
expectEqual('apellido compartido → ambiguo', pick('López'), ['w2', 'w3', 'w4']);
expectEqual('palabras de relleno', pick('elijo a la paciente Manuela'), 'w4');
expectEqual('no está → nada', pick('Zoila'), null);
expectEqual('prefijo de 2 letras no basta', pick('Pa'), null);
expectEqual('input no textual → nada', classifyWaitlistPatient(button('x'), candidates).kind, 'none');

// ─── Lista de espera a voluntad: comando de la doctora (25/09) ──────────────
console.log('\n── isWaitlistCommand ──');
expectEqual('"lista de espera"', isWaitlistCommand('lista de espera'), true);
expectEqual('"Ver lista de espera"', isWaitlistCommand('Ver lista de espera'), true);
expectEqual('mayúsculas y signos', isWaitlistCommand('¿LISTA DE ESPERA?'), true);
expectEqual('frase corta que la pide', isWaitlistCommand('me muestras la lista de espera porfa'), true);
expectEqual('"lista espera" sin "de"', isWaitlistCommand('lista espera'), true);
expectEqual('"lista" suelta no es el comando', isWaitlistCommand('lista'), false);
expectEqual('otra cosa', isWaitlistCommand('agendar cita'), false);
expectEqual('mensaje largo que solo la menciona', isWaitlistCommand('oye una pregunta sobre la lista de espera de la semana que entra por favor'), false);
expectEqual('vacío', isWaitlistCommand(''), false);

// ─── Resultado ───────────────────────────────────────────────────────────────
console.log(`\n${passed} pass / ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
