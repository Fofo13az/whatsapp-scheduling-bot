/**
 * Smoke test de calendarSync (actualización 23/09): el bot detecta los
 * cambios que la doctora hace A MANO en su calendario sobre citas del bot.
 *
 * Sin red: Google Calendar (ambos consultorios ruteados a Google) y la Graph
 * API se stubbean; MySQL real. Los eventos del escenario viven en un mapa en
 * memoria; cualquier otro evento (citas de otras pruebas en la DB de dev)
 * responde 500 → "no verificable" → no se toca.
 *
 * Cubre: recordatorio con la hora nueva (evento movido), sin recordatorio y
 * cita cancelada (evento borrado, 404 o status cancelled), cita movida HACIA
 * mañana, cita movida a otro día, sin UID → se envía igual, calendario sin
 * acceso → no verificable, borrado con lista de espera → aviso de hueco, y el
 * freno de seguridad ante borrados masivos.
 *
 * Uso: node scripts/smoke-calendar-sync.js
 */

import crypto from 'node:crypto';
import 'dotenv/config';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CAL_SUR = 'sur.smoke@group.calendar.google.com';
const CAL_NORTE = 'norte.smoke@group.calendar.google.com';

process.env.GOOGLE_SA_EMAIL = 'scheduler-bot@smoke-sync.iam.gserviceaccount.com';
process.env.GOOGLE_SA_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.GOOGLE_CALENDAR_SUR = CAL_SUR;
process.env.GOOGLE_CALENDAR_NORTE = CAL_NORTE;
delete process.env.CALDAV_USERNAME;
delete process.env.CALDAV_APP_SPECIFIC_PASSWORD;
delete process.env.CALDAV_CALENDAR_NAME;
delete process.env.CALDAV_CALENDAR_SUR;
delete process.env.CALDAV_CALENDAR_NORTE;
delete process.env.REMINDER_TEMPLATE_NAME;
delete process.env.WAITLIST_OFFER_TEMPLATE_NAME;
process.env.DOCTOR_TEMPLATES_ENABLED = 'false';

// ── Stubs: Google Calendar + Graph API ──────────────────────────────────────
const events = new Map(); // eventId → { calendarId, start: Date, end: Date, status }
const unreachableCalendars = new Set();
const graphCalls = [];

globalThis.fetch = async (url, options = {}) => {
  const u = new URL(String(url));
  const method = options.method ?? 'GET';
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  if (u.hostname === 'graph.facebook.com') {
    graphCalls.push(JSON.parse(options.body));
    return json(200, { messages: [{ id: `wamid.sync.${graphCalls.length}` }] });
  }
  if (u.origin === 'https://oauth2.googleapis.com') {
    return json(200, { access_token: 'stub-token', expires_in: 3600 });
  }
  if (u.origin !== 'https://www.googleapis.com') throw new Error(`fetch inesperado: ${method} ${url}`);

  const match = /^\/calendar\/v3\/calendars\/([^/]+)(?:\/events(?:\/([^/]+))?)?$/.exec(u.pathname);
  if (!match || method !== 'GET') throw new Error(`ruta no stubbeada: ${method} ${url}`);
  const calendarId = decodeURIComponent(match[1]);
  const eventId = match[2] ? decodeURIComponent(match[2]) : null;
  const isEventsPath = u.pathname.includes('/events');

  if (!isEventsPath) {
    return unreachableCalendars.has(calendarId)
      ? json(404, { error: { message: 'Not Found' } })
      : json(200, { id: calendarId, summary: calendarId });
  }
  if (!eventId) return json(200, { items: [] }); // listEvents (disponibilidad)

  if (!eventId.startsWith('sync-')) {
    // Evento de otra prueba en la DB de dev: no verificable, no se toca.
    return json(500, { error: { message: 'evento ajeno al smoke' } });
  }
  const event = events.get(eventId);
  if (unreachableCalendars.has(calendarId) || !event || event.calendarId !== calendarId) {
    return json(404, { error: { message: 'Not Found' } });
  }
  return json(200, {
    id: eventId,
    status: event.status ?? 'confirmed',
    start: { dateTime: event.start.toISOString() },
    end: { dateTime: event.end.toISOString() },
  });
};

const appointmentRepository = await import('../src/services/appointmentRepository.js');
const waitlistRepository = await import('../src/services/waitlistRepository.js');
const calendarSync = await import('../src/services/calendarSync.js');
const { runSendReminders } = await import('../src/scheduler/jobs/sendReminders.js');
const { config } = await import('../src/config/index.js');
const { addDays, addMinutes, clinicTimeToUtc, getClinicParts } = await import('../src/lib/dates.js');
const { pool, closeDb } = await import('../src/db/connection.js');
const { randomUUID } = await import('node:crypto');

const PHONE_PREFIX = '52155999940';
const phoneFor = (n) => `${PHONE_PREFIX}${String(n).padStart(2, '0')}`;
const USED_PHONES = Array.from({ length: 20 }, (_, i) => phoneFor(i));
const DOCTOR = config.DOCTOR_PERSONAL_PHONE.replace('+', '').replace(/^521(\d{10})$/, '52$1');

let passed = 0;
let failed = 0;
function expect(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const normalizeMx = (p) => String(p).replace(/^\+/, '').replace(/^521(\d{10})$/, '52$1');
const messagesTo = (phone) => graphCalls.filter((c) => c.to === normalizeMx(phone));
const bodyOf = (m) => m?.text?.body ?? m?.interactive?.body?.text ?? '';
const doctorBodies = (since = 0) => graphCalls.slice(since).filter((c) => c.to === DOCTOR).map(bodyOf);

async function cleanup() {
  await pool.query(
    `DELETE so FROM slot_offers so JOIN appointments a ON a.id = so.source_appointment_id WHERE a.patient_phone IN (?)`,
    [USED_PHONES],
  );
  await pool.query(
    `DELETE w FROM waitlist w JOIN appointments a ON a.id = w.appointment_id WHERE a.patient_phone IN (?)`,
    [USED_PHONES],
  );
  await pool.query('DELETE FROM appointments WHERE patient_phone IN (?)', [USED_PHONES]);
  await pool.query('DELETE FROM patients WHERE phone IN (?)', [USED_PHONES]);
}

function tomorrowAt(hour, minute = 0) {
  return clinicTimeToUtc({ ...getClinicParts(addDays(new Date(), 1)), hour, minute, second: 0 });
}

/** Cita del bot + su evento en el calendario (a la misma hora, salvo eventStart). */
async function appointmentWithEvent(n, name, scheduledAt, { location = 'norte', eventStart = scheduledAt, withEvent = true } = {}) {
  const id = randomUUID();
  const eventId = `sync-${id}`;
  await pool.query('INSERT IGNORE INTO patients (phone, name) VALUES (?, ?)', [phoneFor(n), name]);
  await appointmentRepository.create({
    id,
    patientPhone: phoneFor(n),
    patientName: name,
    consultationType: 'subsecuente',
    location,
    scheduledAt,
    durationMin: 40,
    caldavEventUid: withEvent ? eventId : null,
  });
  if (withEvent) {
    events.set(eventId, {
      calendarId: location === 'norte' ? CAL_NORTE : CAL_SUR,
      start: eventStart,
      end: addMinutes(eventStart, 40),
    });
  }
  return { id, eventId };
}

try {
  await cleanup();

  // Primero: el check de acceso a cada calendario se cachea unos minutos, así
  // que esta prueba va antes de cualquier otra consulta al calendario.
  console.log('\n── Calendario sin acceso: no verificable, no se cancela ──');

  const unreachable = await appointmentWithEvent(8, 'Paula Sur', addDays(tomorrowAt(9), 8), { location: 'sur' });
  unreachableCalendars.add(CAL_SUR);
  const verdict = await calendarSync.verifyAppointment(await appointmentRepository.getById(unreachable.id));
  expect('404 del evento + calendario inaccesible → no verificable (no "borrado")', verdict.status === 'unverifiable', JSON.stringify(verdict));
  unreachableCalendars.clear();

  console.log('\n── Recordatorios con sync previo contra el calendario ──');

  const ok = await appointmentWithEvent(1, 'Olivia Sin Cambios', tomorrowAt(9));
  const moved = await appointmentWithEvent(2, 'Mónica Movida', tomorrowAt(10), { eventStart: tomorrowAt(12) });
  const deleted = await appointmentWithEvent(3, 'Diana Borrada', tomorrowAt(11));
  events.delete(deleted.eventId); // la doctora borró el evento (404)
  const noUid = await appointmentWithEvent(4, 'Nora Sin Evento', tomorrowAt(13), { withEvent: false });
  const movedIn = await appointmentWithEvent(5, 'Inés Adelantada', addDays(tomorrowAt(9), 3), { eventStart: tomorrowAt(15) });

  const callsBefore = graphCalls.length;
  await runSendReminders();

  expect('cita sin cambios: recordatorio normal', messagesTo(phoneFor(1)).some((m) => bodyOf(m).includes('09:00')));

  const movedRow = await appointmentRepository.getById(moved.id);
  expect('evento movido: la cita adopta la hora nueva en la DB', new Date(movedRow.scheduledAt).getTime() === tomorrowAt(12).getTime());
  expect('evento movido: el recordatorio dice la hora NUEVA (12:00)', messagesTo(phoneFor(2)).some((m) => bodyOf(m).includes('12:00') && !bodyOf(m).includes('10:00')),
    JSON.stringify(messagesTo(phoneFor(2)).map(bodyOf)));

  const deletedRow = await appointmentRepository.getById(deleted.id);
  expect('evento borrado: sin recordatorio', messagesTo(phoneFor(3)).length === 0);
  expect('evento borrado: cita cancelada en el bot', deletedRow.status === 'cancelled');
  const doctorNotes = doctorBodies(callsBefore);
  expect('evento borrado sin lista de espera: aviso "cita quitada de tu calendario"',
    doctorNotes.some((b) => b.includes('Cita quitada de tu calendario') && b.includes('Diana Borrada')), JSON.stringify(doctorNotes));

  expect('cita sin evento (no verificable): recordatorio igual', messagesTo(phoneFor(4)).some((m) => bodyOf(m).includes('13:00')));

  const movedInRow = await appointmentRepository.getById(movedIn.id);
  expect('cita movida HACIA mañana: DB actualizada y recibe recordatorio',
    new Date(movedInRow.scheduledAt).getTime() === tomorrowAt(15).getTime()
      && messagesTo(phoneFor(5)).some((m) => bodyOf(m).includes('15:00')));
  expect('a la paciente con cita borrada no se le escribió nada', messagesTo(phoneFor(3)).length === 0);

  console.log('\n── Barrido diario: cita movida a otro día y Google con status cancelled ──');

  const movedAway = await appointmentWithEvent(6, 'Alma Pospuesta', addDays(tomorrowAt(10), 5), { eventStart: addDays(tomorrowAt(11), 7) });
  const cancelledInGoogle = await appointmentWithEvent(7, 'Carla Cancelada En Google', addDays(tomorrowAt(9), 6), { location: 'sur' });
  events.get(cancelledInGoogle.eventId).status = 'cancelled';

  // Ya había recibido (y confirmado) el recordatorio del horario viejo.
  await appointmentRepository.markReminderSent(movedAway.id, 'wamid.old.reminder');
  await appointmentRepository.markConfirmed(movedAway.id);

  let run = await calendarSync.runCalendarSync({ context: 'smoke' });
  expect('sin freno de seguridad con pocas anomalías', run.blocked === false);
  const movedAwayRow = await appointmentRepository.getById(movedAway.id);
  expect('movida a otro día: fecha actualizada',
    new Date(movedAwayRow.scheduledAt).getTime() === addDays(tomorrowAt(11), 7).getTime());
  expect('movida tras su recordatorio: recordatorio y confirmación se reinician para la fecha nueva',
    movedAwayRow.reminderSentAt === null && movedAwayRow.reminderMessageId === null && movedAwayRow.status === 'pending',
    JSON.stringify({ sent: movedAwayRow.reminderSentAt, status: movedAwayRow.status }));
  expect('evento con status "cancelled" en Google cuenta como borrado',
    (await appointmentRepository.getById(cancelledInGoogle.id)).status === 'cancelled');
  const okAfter = await appointmentRepository.getById(ok.id);
  expect('las citas sin cambios quedan intactas', okAfter.status === 'pending' && new Date(okAfter.scheduledAt).getTime() === tomorrowAt(9).getTime());

  console.log('\n── Borrado con lista de espera → aviso de hueco liberado ──');

  const far = await appointmentWithEvent(9, 'Wendy En Espera', addDays(tomorrowAt(10), 25));
  await waitlistRepository.addEntry({ id: randomUUID(), appointmentId: far.id });
  const freed = await appointmentWithEvent(10, 'Beatriz Borrada', addDays(tomorrowAt(10), 4));
  events.delete(freed.eventId);

  let before = graphCalls.length;
  await calendarSync.runCalendarSync({ context: 'smoke' });
  const promptBodies = doctorBodies(before);
  expect('la doctora recibe el aviso de lista de espera con el motivo',
    promptBodies.some((b) => b.includes('Quitaste de tu calendario la cita de Beatriz Borrada')), JSON.stringify(promptBodies));
  expect('y no el aviso genérico de "cita quitada" (uno solo por evento)',
    !promptBodies.some((b) => b.includes('Cita quitada de tu calendario')));

  console.log('\n── Freno de seguridad: borrados masivos ──');

  const massIds = [];
  for (let i = 0; i < 5; i += 1) {
    const appt = await appointmentWithEvent(11 + i, `Masiva ${i}`, addDays(tomorrowAt(9 + i), 10));
    events.delete(appt.eventId);
    massIds.push(appt.id);
  }
  before = graphCalls.length;
  run = await calendarSync.runCalendarSync({ context: 'smoke' });
  const [massRows] = await pool.query('SELECT status FROM appointments WHERE id IN (?)', [massIds]);
  expect('freno activado', run.blocked === true);
  expect('ninguna cita cancelada', massRows.every((r) => r.status === 'pending'), JSON.stringify(massRows));
  expect('la doctora recibe la alerta de "algo raro con el calendario"',
    doctorBodies(before).some((b) => b.includes('aparecieron movidas o borradas a la vez')), JSON.stringify(doctorBodies(before)));
} catch (err) {
  failed += 1;
  console.error('\n💥 Error inesperado en el smoke test:', err);
} finally {
  await cleanup();
  await closeDb();
}

console.log(`\nResultado: ${passed} pass / ${failed} fail · ${graphCalls.length} mensajes simulados`);
process.exit(failed === 0 ? 0 : 1);
