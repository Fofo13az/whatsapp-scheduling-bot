/**
 * Smoke test E2E de Fase 3: recordatorios, confirmaciones, cancelación,
 * reagendamiento y notificaciones a la doctora.
 *
 * Igual que smoke-flow.js: messageHandler y MySQL reales, Graph API
 * stubbeada, CalDAV fuera (degradado a MySQL-only). Los jobs del scheduler
 * se invocan directo (sin esperar al cron).
 *
 * Uso: node scripts/smoke-phase3.js
 */

import 'dotenv/config';

delete process.env.CALDAV_USERNAME;
delete process.env.CALDAV_APP_SPECIFIC_PASSWORD;
delete process.env.CALDAV_CALENDAR_NAME;

// Toggles encendidos para poder verificar las notificaciones.
process.env.NOTIFY_NEW_APPOINTMENT = 'true';
process.env.NOTIFY_CONFIRMATION = 'true';
process.env.NOTIFY_CANCELLATION = 'true';
process.env.NOTIFY_NO_RESPONSE = 'true';
process.env.NOTIFY_RESCHEDULE = 'true';
delete process.env.REMINDER_TEMPLATE_NAME; // forzar fallback interactivo

// ── Stub de la Graph API (antes de los imports dinámicos) ──────────────────
const sentMessages = [];
let wamidCounter = 0;

globalThis.fetch = async (url, options) => {
  if (!String(url).includes('graph.facebook.com')) {
    throw new Error(`fetch inesperado en smoke test: ${url}`);
  }
  sentMessages.push(JSON.parse(options.body));
  wamidCounter += 1;
  return {
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: `wamid.stub.${wamidCounter}` }] }),
  };
};

const { config } = await import('../src/config/index.js');
const { handleIncomingMessage } = await import('../src/handlers/messageHandler.js');
const stateManager = await import('../src/services/stateManager.js');
const appointmentRepository = await import('../src/services/appointmentRepository.js');
const patientRepository = await import('../src/services/patientRepository.js');
const { runSendReminders } = await import('../src/scheduler/jobs/sendReminders.js');
const { runCheckNoResponses } = await import('../src/scheduler/jobs/checkNoResponses.js');
const { clinicTimeToUtc, getClinicParts, addDays } = await import('../src/lib/dates.js');
const { pool, closeDb } = await import('../src/db/connection.js');

const PHONE = '5215599990001'; // teléfono ficticio solo para este smoke test

// Mismo normalizado que whatsappClient.normalizeRecipient (521→52, sin "+").
function normalizeMx(phone) {
  let digits = String(phone).replace(/^\+/, '');
  if (digits.startsWith('521') && digits.length === 13) digits = `52${digits.slice(3)}`;
  return digits;
}
const DOCTOR = normalizeMx(config.DOCTOR_PERSONAL_PHONE);

let inboundCounter = 0;
function baseMessage(overrides) {
  inboundCounter += 1;
  return {
    inputType: 'text',
    from: PHONE,
    profileName: 'Smoke Fase 3',
    waId: PHONE,
    messageId: `wamid.in.p3.${inboundCounter}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    rawType: 'text',
    text: '',
    buttonPayload: null,
    buttonText: null,
    listId: null,
    listTitle: null,
    ...overrides,
  };
}
const text = (t) => baseMessage({ text: t });
const list = (id) => baseMessage({ inputType: 'list', rawType: 'interactive', listId: id });
const button = (id) => baseMessage({ inputType: 'button', rawType: 'interactive', buttonPayload: id });

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

const lastSent = () => sentMessages[sentMessages.length - 1];
const toPatient = () => sentMessages.filter((m) => m.to === normalizeMx(PHONE));
const toDoctor = () => sentMessages.filter((m) => m.to === DOCTOR);
const lastToDoctor = () => toDoctor()[toDoctor().length - 1];
const send = (m) => handleIncomingMessage(m);

/** Cita mañana (día calendario del consultorio) a la hora dada. */
function tomorrowAt(hour, minute = 0) {
  const todayNoon = clinicTimeToUtc({ ...getClinicParts(new Date()), hour: 12, minute: 0 });
  const tomorrowParts = getClinicParts(addDays(todayNoon, 1));
  return clinicTimeToUtc({ ...tomorrowParts, hour, minute });
}

async function createAppointment({ id, hour, minute = 0, location = 'sur', type = 'primera_vez' }) {
  await appointmentRepository.create({
    id,
    patientPhone: PHONE,
    patientName: 'Paciente Fase Tres',
    consultationType: type,
    location,
    scheduledAt: tomorrowAt(hour, minute),
    durationMin: 40,
    patientNotes: null,
  });
  return appointmentRepository.getById(id);
}

async function statusOf(id) {
  const appt = await appointmentRepository.getById(id);
  return appt?.status ?? null;
}

async function cleanup() {
  await pool.query('DELETE FROM conversations WHERE phone = ?', [PHONE]);
  await pool.query('UPDATE appointments SET rescheduled_from_id = NULL WHERE patient_phone = ?', [PHONE]);
  await pool.query('DELETE FROM appointments WHERE patient_phone = ?', [PHONE]);
  await pool.query('DELETE FROM patients WHERE phone = ?', [PHONE]);
}

try {
  await cleanup();
  await patientRepository.upsertPatientInfo(PHONE, 'Paciente Fase Tres');

  const { randomUUID } = await import('node:crypto');
  const id1 = randomUUID();
  const id2 = randomUUID();
  const id3 = randomUUID();
  const id4 = randomUUID();

  console.log('\n── Job de recordatorios ──');

  // Nota: el job es global (toda cita de mañana en la DB de dev entra), así
  // que las aserciones se anclan a NUESTRA cita, no a los totales.
  await createAppointment({ id: id1, hour: 9 });
  let result = await runSendReminders();
  expect('recordatorio enviado sin fallos', result.sent >= 1 && result.failed === 0, JSON.stringify(result));

  const findReminder = (id) => sentMessages.find(
    (m) => m.interactive?.action?.buttons?.[0]?.reply?.id === `reminder_confirm_${id}`,
  );
  const reminderMsg = findReminder(id1);
  expect('recordatorio con botones y UUID en payload', reminderMsg?.interactive?.type === 'button');
  expect('recordatorio dirigido a la paciente', reminderMsg?.to === normalizeMx(PHONE));

  let appt1 = await appointmentRepository.getById(id1);
  expect('reminder_sent_at registrado', appt1.reminderSentAt != null);

  const countReminders = (id) => sentMessages.filter(
    (m) => m.interactive?.action?.buttons?.[0]?.reply?.id === `reminder_confirm_${id}`,
  ).length;
  const remindersBefore = countReminders(id1);
  await runSendReminders();
  expect('re-corrida idempotente (sin segundo envío)', countReminders(id1) === remindersBefore);

  console.log('\n── Confirmación por botón ──');

  await send(button(`reminder_confirm_${id1}`));
  expect('cita confirmada en DB', (await statusOf(id1)) === 'confirmed');
  expect('respuesta de gracias a la paciente', toPatient().at(-1)?.text?.body.includes('Gracias por confirmar'));
  expect('doctora notificada de confirmación', lastToDoctor()?.text?.body.includes('confirmó su cita'));

  await send(button(`reminder_confirm_${id1}`));
  expect('botón repetido no rompe (sigue confirmed)', (await statusOf(id1)) === 'confirmed');

  console.log('\n── Chequeo de no-respuesta ──');

  await createAppointment({ id: id2, hour: 10 });
  await runSendReminders();
  result = await runCheckNoResponses();
  expect('paciente sin respuesta detectada', result.unconfirmed >= 1, JSON.stringify(result));
  expect(
    'doctora avisada de no-respuesta de NUESTRA paciente',
    toDoctor().some((m) => m.text?.body.includes('no ha confirmado') && m.text?.body.includes('Paciente Fase Tres')),
  );

  console.log('\n── Cancelación desde el recordatorio ──');

  await send(button(`reminder_cancel_${id2}`));
  expect('cita cancelada en DB', (await statusOf(id2)) === 'cancelled');
  expect('respuesta de cancelación a la paciente', toPatient().at(-1)?.text?.body.includes('liberé el horario'));
  expect('doctora notificada de cancelación', lastToDoctor()?.text?.body.includes('canceló su cita'));

  console.log('\n── "Sí" de texto libre como confirmación ──');

  await createAppointment({ id: id3, hour: 11 });
  await runSendReminders();
  await send(text('sí'));
  expect('texto "sí" confirma la cita recordada', (await statusOf(id3)) === 'confirmed');

  console.log('\n── Flujo de cancelación ──');

  await createAppointment({ id: id4, hour: 12 });
  // Activas en este punto: id1 (confirmed), id3 (confirmed), id4 (pending).
  await send(text('quiero cancelar mi cita'));
  expect('varias citas → list de selección', lastSent()?.interactive?.type === 'list');
  let state = await stateManager.getState(PHONE);
  expect('estado = SELECTING_APPOINTMENT', state?.currentStep === 'SELECTING_APPOINTMENT');

  await send(list(`appt_${id4}`));
  expect('cita elegida → botones de confirmación', lastSent()?.interactive?.type === 'button');
  state = await stateManager.getState(PHONE);
  expect('estado = CONFIRMING_CANCEL', state?.currentStep === 'CONFIRMING_CANCEL');

  await send(button(`cancel_no_${id4}`));
  expect('"conservar" → cita sigue pending', (await statusOf(id4)) === 'pending');
  expect('estado limpio tras conservar', (await stateManager.getState(PHONE)) === null);
  expect('mensaje de cita conservada', toPatient().at(-1)?.text?.body.includes('sigue en pie'));

  await send(text('cancelar'));
  await send(list(`appt_${id4}`));
  await send(button(`cancel_yes_${id4}`));
  expect('cancel_yes → cita cancelada', (await statusOf(id4)) === 'cancelled');
  expect('estado limpio tras cancelar', (await stateManager.getState(PHONE)) === null);
  expect('doctora notificada (flujo de cancelación)', lastToDoctor()?.text?.body.includes('canceló su cita'));

  console.log('\n── Flujo de reagendamiento ──');

  // Activas: id1 y id3 (confirmed) → selección.
  await send(text('quiero reagendar'));
  expect('reagendar → list de selección', lastSent()?.interactive?.type === 'list');

  await send(list(`appt_${id1}`));
  state = await stateManager.getState(PHONE);
  expect('cita elegida → fechas nuevas', state?.currentStep === 'SELECTING_NEW_DATE');
  expect('menú de fechas enviado', lastSent()?.interactive?.type === 'list');
  expect(
    'intro con la cita actual',
    sentMessages.at(-2)?.text?.body.includes('Tu cita actual'),
  );

  await send(text('1'));
  state = await stateManager.getState(PHONE);
  expect('fecha elegida → horarios', state?.currentStep === 'SELECTING_NEW_TIME');
  const offeredSlots = state?.contextData?.offeredSlots ?? [];
  expect('hay slots ofrecidos', offeredSlots.length > 0);

  await send(text(offeredSlots[0]));
  state = await stateManager.getState(PHONE);
  expect('hora elegida → confirmación de cambio', state?.currentStep === 'CONFIRMING_CHANGE');
  expect('mensaje de confirmación con antes/ahora', lastSent()?.interactive?.body?.text.includes('Antes:'));

  await send(button('confirm_yes'));
  expect('cita vieja marcada rescheduled', (await statusOf(id1)) === 'rescheduled');

  const [newRows] = await pool.query(
    `SELECT * FROM appointments WHERE rescheduled_from_id = ?`,
    [id1],
  );
  expect('cita nueva creada con rescheduled_from_id', newRows.length === 1);
  expect('cita nueva en pending', newRows[0]?.status === 'pending');
  expect('mensaje de éxito a la paciente', toPatient().at(-1)?.text?.body.includes('reagendada'));
  expect('doctora notificada de reagendamiento', lastToDoctor()?.text?.body.includes('reagendó su cita'));
  expect('estado limpio al terminar', (await stateManager.getState(PHONE)) === null);

  console.log(`\n${passed} pass / ${failed} fail · ${sentMessages.length} mensajes salientes simulados`);
} finally {
  await cleanup();
  await closeDb();
}

process.exit(failed > 0 ? 1 : 0);
