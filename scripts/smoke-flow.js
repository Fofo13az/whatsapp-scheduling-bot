/**
 * Smoke test E2E del appointmentFlow. NO COMMITEAR (.gitignore).
 *
 * Simula una conversación completa contra el messageHandler real y la DB
 * real (MySQL local), pero con la Graph API stubbeada: se intercepta
 * globalThis.fetch ANTES de importar los módulos, así whatsappClient "envía"
 * sin red y podemos inspeccionar qué mensajes habría mandado el bot.
 *
 * Uso: node scripts/smoke-flow.js
 */

import 'dotenv/config';

// CalDAV queda FUERA de este smoke: sin config, el flujo degrada a
// MySQL-only y la cita se crea sin caldav_event_uid. El ciclo completo de
// calendario se prueba aparte contra iCloud real en smoke-caldav.js.
delete process.env.CALDAV_USERNAME;
delete process.env.CALDAV_APP_SPECIFIC_PASSWORD;
delete process.env.CALDAV_CALENDAR_NAME;

// ── Stub de la Graph API (debe instalarse antes de los imports dinámicos) ──
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

const { handleIncomingMessage } = await import('../src/handlers/messageHandler.js');
const stateManager = await import('../src/services/stateManager.js');
const { pool, closeDb } = await import('../src/db/connection.js');

const PHONE = '5215599990000'; // teléfono ficticio solo para este smoke test

let inboundCounter = 0;
function baseMessage(overrides) {
  inboundCounter += 1;
  return {
    inputType: 'text',
    from: PHONE,
    profileName: 'Smoke Test',
    waId: PHONE,
    messageId: `wamid.in.${inboundCounter}`,
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

function lastSent() {
  return sentMessages[sentMessages.length - 1];
}

async function send(message) {
  await handleIncomingMessage(message);
}

async function cleanup() {
  await pool.query('DELETE FROM conversations WHERE phone = ?', [PHONE]);
  await pool.query('DELETE FROM appointments WHERE patient_phone = ?', [PHONE]);
  await pool.query('DELETE FROM patients WHERE phone = ?', [PHONE]);
}

try {
  await cleanup();

  console.log('\n── IDLE ──');

  await send(text('hola!'));
  expect('saludo → greeting de texto', lastSent()?.type === 'text' && lastSent().text.body.includes('asistente'));

  await send(text('asdfghjk'));
  expect('texto random → unknown', lastSent()?.text?.body.includes('no entendí'));

  await send(text('quiero cancelar mi cita'));
  expect('cancelar sin citas → noAppointmentsFound', lastSent()?.text?.body.includes('No encuentro citas'));

  console.log('\n── Flujo de agendado ──');

  await send(text('quiero agendar una cita'));
  expect('intent agendar → botones de tipos', lastSent()?.interactive?.type === 'button');
  let state = await stateManager.getState(PHONE);
  expect('estado = SELECTING_TYPE', state?.currentStep === 'SELECTING_TYPE');

  await send(text('no sé qué elegir'));
  expect('input inválido → re-envía menú de tipos', lastSent()?.interactive?.type === 'button');
  state = await stateManager.getState(PHONE);
  expect('sigue en SELECTING_TYPE', state?.currentStep === 'SELECTING_TYPE');

  await send(button('type_primera_vez'));
  expect('type_primera_vez → botones de consultorio', lastSent()?.interactive?.type === 'button');
  state = await stateManager.getState(PHONE);
  expect('estado = SELECTING_LOCATION', state?.currentStep === 'SELECTING_LOCATION');
  expect('contexto trae durationMin 40', state?.contextData?.durationMin === 40);

  await send(button('loc_sur'));
  state = await stateManager.getState(PHONE);
  expect('loc_sur → list de fechas', lastSent()?.interactive?.type === 'list');
  expect('estado = SELECTING_DATE', state?.currentStep === 'SELECTING_DATE');
  const offeredDates = state?.contextData?.offeredDates ?? [];
  expect('hay fechas ofrecidas en contexto', offeredDates.length > 0);

  await send(text('1'));
  state = await stateManager.getState(PHONE);
  expect('fecha "1" → list de horarios', lastSent()?.interactive?.type === 'list');
  expect('estado = SELECTING_TIME', state?.currentStep === 'SELECTING_TIME');
  const offeredSlots = state?.contextData?.offeredSlots ?? [];
  expect('hay slots ofrecidos en contexto', offeredSlots.length > 0);

  await send(list(`slot_${state.contextData.date}_${offeredSlots[0]}`));
  state = await stateManager.getState(PHONE);
  expect('slot elegido → pide nombre', lastSent()?.text?.body.includes('nombre completo'));
  expect('estado = COLLECTING_NAME', state?.currentStep === 'COLLECTING_NAME');

  console.log('\n── Comando atrás ──');

  await send(text('atrás'));
  state = await stateManager.getState(PHONE);
  expect('atrás desde nombre → regresa a horarios', state?.currentStep === 'SELECTING_TIME');
  expect('re-envió list de horarios', lastSent()?.interactive?.type === 'list');

  await send(text(state.contextData.offeredSlots[0]));
  state = await stateManager.getState(PHONE);
  expect('hora en texto libre → pide nombre otra vez', state?.currentStep === 'COLLECTING_NAME');

  console.log('\n── Nombre, notas y confirmación ──');

  await send(text('María'));
  state = await stateManager.getState(PHONE);
  expect('nombre incompleto → rechazado', state?.currentStep === 'COLLECTING_NAME');
  expect('mensaje de nombre inválido', lastSent()?.text?.body.includes('nombre válido'));

  await send(text('María Prueba Smoke'));
  state = await stateManager.getState(PHONE);
  expect('nombre válido → pide notas', state?.currentStep === 'COLLECTING_NOTES');

  await send(text('Tengo 8 semanas de embarazo'));
  state = await stateManager.getState(PHONE);
  expect('notas → botones de confirmación', lastSent()?.interactive?.type === 'button');
  expect('estado = CONFIRMING', state?.currentStep === 'CONFIRMING');
  expect('resumen incluye nombre', lastSent()?.interactive?.body?.text.includes('María Prueba Smoke'));
  expect('resumen incluye notas', lastSent()?.interactive?.body?.text.includes('8 semanas'));

  const ctxBefore = state.contextData;
  await send(button('confirm_yes'));
  expect('confirmación → mensaje de cita creada', lastSent()?.text?.body.includes('quedó registrada'));
  state = await stateManager.getState(PHONE);
  expect('estado limpiado tras crear cita', state === null);

  const [apptRows] = await pool.query(
    `SELECT * FROM appointments WHERE patient_phone = ? AND status = 'pending'`,
    [PHONE],
  );
  expect('cita en DB con status pending', apptRows.length === 1);
  // Sin CalDAV configurado el evento no se crea, pero la cita SÍ (diseño
  // DB-first): el uid debe quedar NULL y el flujo terminar sin error.
  expect('cita sin caldav_event_uid (degradado sin CalDAV)', apptRows[0]?.caldav_event_uid == null);
  expect('tipo correcto', apptRows[0]?.consultation_type === 'primera_vez');
  expect('notas guardadas', apptRows[0]?.patient_notes === 'Tengo 8 semanas de embarazo');

  const [patientRows] = await pool.query('SELECT * FROM patients WHERE phone = ?', [PHONE]);
  expect('paciente registrada', patientRows.length === 1 && patientRows[0].name === 'María Prueba Smoke');

  console.log('\n── Slot ocupado (doble booking) ──');

  // Segunda cita al MISMO horario: el flujo no debería ofrecer ese slot.
  await send(text('agendar'));
  await send(button('type_primera_vez'));
  await send(button('loc_sur'));
  state = await stateManager.getState(PHONE);
  const sameDate = state.contextData.offeredDates.find((d) => d.date === ctxBefore.date);
  if (sameDate) {
    await send(list(`date_${sameDate.date}`));
    state = await stateManager.getState(PHONE);
    expect(
      'slot ya tomado NO se ofrece de nuevo',
      !(state?.contextData?.offeredSlots ?? []).includes(ctxBefore.time),
      `— ofrecidos: ${state?.contextData?.offeredSlots}`,
    );
  } else {
    expect('slot ya tomado NO se ofrece de nuevo (fecha llena, desapareció)', true);
  }

  await send(text('cancelar'));
  state = await stateManager.getState(PHONE);
  expect('comando cancelar → estado limpio', state === null);
  expect('mensaje de cancelación', lastSent()?.text?.body.includes('cancelé el proceso'));

  console.log('\n── Dedupe por wamid ──');

  const sentBefore = sentMessages.length;
  const dup = text('hola');
  await send(dup);
  await send({ ...dup }); // mismo messageId
  expect('mensaje duplicado ignorado (solo 1 respuesta)', sentMessages.length === sentBefore + 1);

  console.log(`\n${passed} pass / ${failed} fail · ${sentMessages.length} mensajes salientes simulados`);
} finally {
  await cleanup();
  await closeDb();
}

process.exit(failed > 0 ? 1 : 0);
