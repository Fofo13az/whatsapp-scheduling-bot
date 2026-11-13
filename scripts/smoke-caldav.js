/**
 * Smoke test E2E de caldavService contra el iCloud REAL configurado en .env.
 * NO COMMITEAR (.gitignore).
 *
 * ⚠️ Requiere credenciales CALDAV_* y crea/borra eventos de prueba en los
 * calendarios configurados — usar SOLO con calendarios de prueba, nunca con
 * los de la doctora (regla de fases de CLAUDE.md).
 *
 * Cubre el mapeo consultorio → calendario: crea un evento por consultorio,
 * verifica que ambos aparecen en la lectura fusionada (bloqueo global), los
 * borra y confirma que desaparecen.
 *
 * Uso: node scripts/smoke-caldav.js
 */

import 'dotenv/config';
import * as caldavService from '../src/services/caldavService.js';
import { addDays, addMinutes } from '../src/lib/dates.js';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

if (!caldavService.isConfigured()) {
  console.error(
    'CalDAV no está configurado. Llena CALDAV_USERNAME, CALDAV_APP_SPECIFIC_PASSWORD y ' +
      'los calendarios (CALDAV_CALENDAR_SUR / CALDAV_CALENDAR_NORTE, o CALDAV_CALENDAR_NAME como fallback) en .env',
  );
  process.exit(1);
}

console.log('\n── ping ──');
const status = await caldavService.ping();
check('conexión y calendarios encontrados', status.ok, status.ok ? '' : status.error);
if (!status.ok) {
  console.log('\nSin conexión no hay nada más que probar.');
  process.exit(1);
}
const locations = Object.keys(status.calendars);
for (const [loc, cal] of Object.entries(status.calendars)) {
  console.log(`  → ${loc}: "${cal}"`);
}

// Un evento de prueba por consultorio: mañana a esta hora, 30 min, separados
// una hora entre sí para distinguirlos.
const base = addDays(new Date(), 1);
base.setSeconds(0, 0);

const created = [];
console.log('\n── createEvent (uno por consultorio) ──');
for (const [i, location] of locations.entries()) {
  const start = addMinutes(base, i * 60);
  const end = addMinutes(start, 30);
  const { uid } = await caldavService.createEvent({
    summary: `🧪 SMOKE TEST ${location} — se borra solo`,
    start,
    end,
    description: 'Creado por scripts/smoke-caldav.js. Si sigues viendo esto, el test falló a medias.',
    location,
  });
  check(`createEvent ${location} devuelve uid`, typeof uid === 'string' && uid.length > 0);
  created.push({ uid, location, start, end });
}

console.log('\n── listEvents (lectura fusionada de todos los calendarios) ──');
const windowFrom = addMinutes(base, -60);
const windowTo = addMinutes(base, locations.length * 60 + 90);
let events = await caldavService.listEvents({ from: windowFrom, to: windowTo });

for (const { uid, location, start, end } of created) {
  const found = events.find((e) => e.uid === uid);
  check(`evento de ${location} aparece en la lista fusionada`, Boolean(found));
  if (found) {
    check(
      `${location}: summary correcto`,
      found.summary === `🧪 SMOKE TEST ${location} — se borra solo`,
      `recibido: ${found.summary}`,
    );
    check(
      `${location}: horario correcto`,
      found.start.getTime() === start.getTime() && found.end.getTime() === end.getTime(),
      `esperado ${start.toISOString()}–${end.toISOString()}, recibido ${found.start.toISOString()}–${found.end.toISOString()}`,
    );
    check(`${location}: location correcto`, found.location === location, `recibido: ${found.location}`);
  }
}

console.log('\n── deleteEvent ──');
for (const { uid, location } of created) {
  const del = await caldavService.deleteEvent({ uid, location });
  check(`deleteEvent ${location} ok`, del.ok === true);
}

events = await caldavService.listEvents({ from: windowFrom, to: windowTo });
check(
  'ningún evento de prueba sigue apareciendo',
  created.every(({ uid }) => !events.some((e) => e.uid === uid)),
);

const delAgain = await caldavService.deleteEvent({ uid: created[0].uid, location: created[0].location });
check('borrar dos veces reporta ok:false (404)', delAgain.ok === false);

console.log(`\n${passed} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
