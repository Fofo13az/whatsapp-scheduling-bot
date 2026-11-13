/**
 * Smoke test ad-hoc para messageBuilder. NO COMMITEAR (.gitignore).
 *
 * Verifica que las 9 funciones devuelven el shape esperado con inputs válidos
 * y que las validaciones disparan errores con inputs inválidos.
 *
 * Uso: node scripts/smoke-messageBuilder.js
 */

import 'dotenv/config';
import {
  buildTextMessage,
  buildButtonsMessage,
  buildListMessage,
  buildTypeSelectionMessage,
  buildLocationSelectionMessage,
  buildDateSelectionMessage,
  buildTimeSelectionMessage,
  buildConfirmationMessage,
  buildReminderMessage,
  buildLongTextMessages,
  buildWaitlistPatientDetailMessage,
  buildWaitlistGeneralDetailMessage,
  buildWaitlistDateSelectionMessage,
  buildWaitlistTimeSelectionMessage,
  buildWaitlistManualConfirmMessage,
} from '../src/services/messageBuilder.js';

const TO = '5215512345678';
const results = [];
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const out = fn();
    results.push({ name, status: 'ok', out });
    passed += 1;
  } catch (err) {
    results.push({ name, status: 'FAIL', error: err.message });
    failed += 1;
  }
}

function expectThrow(name, fn, expectedSubstring) {
  try {
    fn();
    results.push({ name, status: 'FAIL', error: 'No se lanzó error como se esperaba' });
    failed += 1;
  } catch (err) {
    if (expectedSubstring && !err.message.includes(expectedSubstring)) {
      results.push({ name, status: 'FAIL', error: `Mensaje no contiene "${expectedSubstring}": ${err.message}` });
      failed += 1;
    } else {
      results.push({ name, status: 'ok (threw)', error: err.message });
      passed += 1;
    }
  }
}

// ── Casos válidos ───────────────────────────────────────────────────────────
check('buildTextMessage básico', () => buildTextMessage(TO, 'Hola'));

check('buildButtonsMessage 2 botones', () =>
  buildButtonsMessage(TO, '¿Cuál?', [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ]));

check('buildListMessage 1 sección 3 items', () =>
  buildListMessage(TO, '¿Qué prefieres?', 'Ver opciones', [
    {
      title: 'Opciones',
      items: [
        { id: 'x1', label: 'Uno', description: 'Primero' },
        { id: 'x2', label: 'Dos' },
        { id: 'x3', label: 'Tres' },
      ],
    },
  ]));

check('buildTypeSelectionMessage', () => buildTypeSelectionMessage(TO));
check('buildLocationSelectionMessage', () => buildLocationSelectionMessage(TO));
check('buildDateSelectionMessage 3 fechas', () =>
  buildDateSelectionMessage(TO, [
    { date: '13/05/2026', label: 'Miércoles 13 de mayo' },
    { date: '15/05/2026', label: 'Viernes 15 de mayo' },
    { date: '18/05/2026', label: 'Lunes 18 de mayo' },
  ]));
check('buildTimeSelectionMessage 4 slots', () =>
  buildTimeSelectionMessage(TO, '13/05/2026', 'Miércoles 13 de mayo', ['09:00', '09:30', '10:00', '10:30']));
check('buildConfirmationMessage', () =>
  buildConfirmationMessage(TO, {
    typeLabel: 'Control de embarazo',
    locationLabel: 'Sur',
    dateLabel: 'Miércoles 13 de mayo',
    timeLabel: '10:00',
    name: 'María González',
    notes: 'Primer trimestre',
  }));
check('buildReminderMessage', () =>
  buildReminderMessage(TO, 'a1b2c3d4-0000-0000-0000-000000000000', {
    name: 'María',
    dateLabel: 'Miércoles 13 de mayo',
    timeLabel: '10:00',
    locationLabel: 'Sur',
  }));

// ── Casos que deben lanzar ──────────────────────────────────────────────────
expectThrow('to inválido', () => buildTextMessage('whatsapp:+5215512345678', 'Hola'), 'E.164');
expectThrow('body vacío', () => buildTextMessage(TO, ''), 'body');
expectThrow('4 botones', () => buildButtonsMessage(TO, 'X', [
  { id: '1', label: 'A' },
  { id: '2', label: 'B' },
  { id: '3', label: 'C' },
  { id: '4', label: 'D' },
]), 'entre 1 y 3');
expectThrow('label muy largo', () => buildButtonsMessage(TO, 'X', [
  { id: '1', label: 'A'.repeat(25) },
]), 'excede 20');
expectThrow('IDs duplicados', () => buildButtonsMessage(TO, 'X', [
  { id: 'same', label: 'A' },
  { id: 'same', label: 'B' },
]), 'duplicado');
expectThrow('list >10 items', () => buildListMessage(TO, 'X', 'Ver', [{
  title: 'T',
  items: Array.from({ length: 11 }, (_, i) => ({ id: `it_${i}`, label: `Item ${i}` })),
}]), 'excede 10');

// ── Actualización 23/09: textos largos y detalle de lista de espera ─────────
check('buildTextMessage acepta hasta 4096 chars (límite real de texto)', () => {
  const out = buildTextMessage(TO, 'a'.repeat(4096));
  if (out.body.length !== 4096) throw new Error('body alterado');
  return 'ok';
});

expectThrow('buildTextMessage > 4096 chars', () => buildTextMessage(TO, 'a'.repeat(4097)), 'excede 4096');

expectThrow('mensaje con botones sigue limitado a 1024', () =>
  buildButtonsMessage(TO, 'a'.repeat(1025), [{ id: 'a', label: 'A' }]), 'excede 1024');

check('buildLongTextMessages: texto corto → 1 mensaje intacto', () => {
  const out = buildLongTextMessages(TO, 'línea 1\nlínea 2');
  if (out.length !== 1 || out[0].body !== 'línea 1\nlínea 2') throw new Error(JSON.stringify(out));
  return 'ok';
});

check('buildLongTextMessages: parte entre líneas sin perder ni cortar renglones', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `${i + 1}. ${'x'.repeat(40)}`);
  const out = buildLongTextMessages(TO, lines.join('\n'), 200);
  if (out.length < 2) throw new Error(`esperaba varios mensajes, llegaron ${out.length}`);
  if (out.some((m) => m.body.length > 200)) throw new Error('un mensaje excede el máximo');
  const rejoined = out.map((m) => m.body).join('\n').split('\n');
  if (JSON.stringify(rejoined) !== JSON.stringify(lines)) throw new Error('se perdieron o cortaron renglones');
  return `${out.length} mensajes`;
});

check('buildWaitlistPatientDetailMessage: botones pick/skip con UUIDs', () => {
  const offerId = '11111111-1111-4111-8111-111111111111';
  const waitlistId = '22222222-2222-4222-8222-222222222222';
  const out = buildWaitlistPatientDetailMessage(TO, offerId, waitlistId, 'Detalle');
  const ids = out.buttons.map((b) => b.id);
  if (ids[0] !== `wl_pick_${offerId}_${waitlistId}` || ids[1] !== `wl_skip_${offerId}`) throw new Error(JSON.stringify(ids));
  return 'ok';
});

// ── Lista de espera a voluntad (25/09) ──────────────────────────────────────
const WL = '22222222-2222-4222-8222-222222222222';

check('buildWaitlistGeneralDetailMessage: botón "Buscarle horario" (wl_slots_)', () => {
  const out = buildWaitlistGeneralDetailMessage(TO, WL, 'Detalle');
  if (out.buttons.length !== 1 || out.buttons[0].id !== `wl_slots_${WL}`) throw new Error(JSON.stringify(out.buttons));
  return 'ok';
});

check('buildWaitlistDateSelectionMessage: 10 días de ambos consultorios', () => {
  const days = Array.from({ length: 10 }, (_, i) => ({
    location: i % 2 ? 'sur' : 'norte',
    date: `${String(i + 1).padStart(2, '0')}/10/2026`,
    shortLabel: `Jue ${i + 1} oct`,
    description: 'Clínica Sur · 12 horarios',
  }));
  const out = buildWaitlistDateSelectionMessage(TO, WL, 'Elige día', days);
  const ids = out.sections[0].items.map((it) => it.id);
  if (ids[1] !== `wl_date_${WL}_sur_02/10/2026`) throw new Error(ids[1]);
  return `${ids.length} filas`;
});

expectThrow('buildWaitlistDateSelectionMessage: 11 días → excede el límite', () =>
  buildWaitlistDateSelectionMessage(TO, WL, 'Elige día', Array.from({ length: 11 }, (_, i) => ({
    location: 'norte', date: `${String(i + 1).padStart(2, '0')}/10/2026`, shortLabel: `Día ${i + 1}`, description: 'x',
  }))), 'excede');

check('buildWaitlistTimeSelectionMessage: 13 horarios → 9 + "Ver más" con la página siguiente', () => {
  const slots = Array.from({ length: 13 }, (_, i) => `${String(8 + Math.floor(i * 40 / 60)).padStart(2, '0')}:${String((i * 40) % 60).padStart(2, '0')}`);
  const out = buildWaitlistTimeSelectionMessage(TO, WL, 'sur', '06/10/2026', 'Elige hora', slots, 0);
  const ids = out.sections[0].items.map((it) => it.id);
  if (ids.length !== 10 || ids[9] !== `wl_tpage_${WL}_sur_06/10/2026_1`) throw new Error(JSON.stringify(ids.slice(-2)));
  if (ids[0] !== `wl_time_${WL}_sur_06/10/2026_08:00`) throw new Error(ids[0]);
  const last = buildWaitlistTimeSelectionMessage(TO, WL, 'sur', '06/10/2026', 'Elige hora', slots, 1);
  if (last.sections[0].items.some((it) => it.id.startsWith('wl_tpage_'))) throw new Error('la última página no lleva "Ver más"');
  return 'ok';
});

check('buildWaitlistManualConfirmMessage: "Sí, ofrecérselo" (wl_send_) / "Otro horario" (wl_slots_)', () => {
  const out = buildWaitlistManualConfirmMessage(TO, WL, 'norte', '05/10/2026', '10:40', '¿Le ofrezco?');
  const ids = out.buttons.map((b) => b.id);
  if (ids[0] !== `wl_send_${WL}_norte_05/10/2026_10:40` || ids[1] !== `wl_slots_${WL}`) throw new Error(JSON.stringify(ids));
  return 'ok';
});

// ── Reporte ─────────────────────────────────────────────────────────────────
console.log('\n══════ RESULTADOS ══════\n');
for (const r of results) {
  const tag = r.status === 'ok' || r.status === 'ok (threw)' ? '✓' : '✗';
  console.log(`${tag} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
}

console.log(`\n${passed} pass, ${failed} fail\n`);

if (failed > 0) {
  process.exit(1);
}

// Imprime un payload de muestra para inspección manual
console.log('── Muestra: buildTypeSelectionMessage ──');
console.log(JSON.stringify(buildTypeSelectionMessage(TO), null, 2));

console.log('\n── Muestra: buildLocationSelectionMessage ──');
console.log(JSON.stringify(buildLocationSelectionMessage(TO), null, 2));

console.log('\n── Muestra: buildConfirmationMessage ──');
console.log(JSON.stringify(buildConfirmationMessage(TO, {
  typeLabel: 'Control de embarazo',
  locationLabel: 'Sur',
  dateLabel: 'Miércoles 13 de mayo',
  timeLabel: '10:00',
  name: 'María González',
  notes: 'Primer trimestre',
}), null, 2));
