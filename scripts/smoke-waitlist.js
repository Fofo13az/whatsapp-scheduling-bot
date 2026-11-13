/**
 * Smoke test E2E de la actualización del 19/08/2026:
 *   1. Mensaje de indicaciones de llegada (firstVisitInfo de Clínica Norte)
 *      la primera vez que una paciente agenda en ese consultorio.
 *   2. Lista de espera completa: invitación al agendar lejos, hueco liberado
 *      por cancelación, elección de la doctora, rechazo y aceptación de la
 *      paciente con swap de cita.
 *
 * Actualización 23/09: la doctora ve la lista COMPLETA en texto (se parte en
 * varios mensajes si es larga — se prueba con 70 pacientes sembradas) y elige
 * escribiendo el nombre o el número; limpieza periódica de la lista.
 *
 * Igual que smoke-phase3.js: messageHandler y MySQL reales, Graph API
 * stubbeada, CalDAV fuera (degradado a MySQL-only).
 *
 * Uso: node scripts/smoke-waitlist.js
 */

import 'dotenv/config';

delete process.env.CALDAV_USERNAME;
delete process.env.CALDAV_APP_SPECIFIC_PASSWORD;
delete process.env.CALDAV_CALENDAR_NAME;
// Sin calendarios: el smoke no debe depender de (ni tocar) calendarios reales.
delete process.env.GOOGLE_CALENDAR_SUR;
delete process.env.GOOGLE_CALENDAR_NORTE;
delete process.env.REMINDER_TEMPLATE_NAME;
delete process.env.WAITLIST_OFFER_TEMPLATE_NAME;
process.env.DOCTOR_TEMPLATES_ENABLED = 'false';
process.env.NOTIFY_CANCELLATION = 'true';
process.env.NOTIFY_RESCHEDULE = 'true';
// Umbral bajo para que la cita del flujo (últimas fechas ofrecidas, ~4-7 días)
// dispare la invitación a la lista de espera de forma determinista.
process.env.WAITLIST_MIN_DAYS_AHEAD = '2';

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
const appointmentRepository = await import('../src/services/appointmentRepository.js');
const waitlistRepository = await import('../src/services/waitlistRepository.js');
const waitlistService = await import('../src/services/waitlistService.js');
const { cancelAppointment } = await import('../src/services/appointmentLifecycle.js');
const { addMinutes, addDays } = await import('../src/lib/dates.js');
const { pool, closeDb } = await import('../src/db/connection.js');
const { randomUUID } = await import('node:crypto');

// Teléfonos ficticios solo para este smoke test.
const PHONE_A = '5215599990011'; // María — agenda lejos por el flujo, entra a la lista
const PHONE_B = '5215599990012'; // Paulina — cita cercana que cancela
const PHONE_C = '5215599990013'; // Natalia — en lista, rechaza la oferta
// 70 pacientes sembradas para la lista larga (el caso real: 74 en la lista).
const SEED_COUNT = 70;
const SEED_PHONES = Array.from({ length: SEED_COUNT }, (_, i) => `52155999920${String(i).padStart(2, '0')}`);
const ALL_PHONES = [PHONE_A, PHONE_B, PHONE_C, ...SEED_PHONES];

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
    from: PHONE_A,
    profileName: 'Smoke Waitlist',
    waId: PHONE_A,
    messageId: `wamid.in.wl.${inboundCounter}`,
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
const text = (t, from = PHONE_A) => baseMessage({ text: t, from, waId: from });
const list = (id, from = PHONE_A) => baseMessage({ inputType: 'list', rawType: 'interactive', listId: id, from, waId: from });
const button = (id, from = PHONE_A) => baseMessage({ inputType: 'button', rawType: 'interactive', buttonPayload: id, from, waId: from });

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

const send = (m) => handleIncomingMessage(m);
const to = (phone) => sentMessages.filter((m) => m.to === normalizeMx(phone));
const lastTo = (phone) => to(phone).at(-1);
const toDoctor = () => sentMessages.filter((m) => m.to === DOCTOR);
const lastToDoctor = () => toDoctor().at(-1);
const buttonIds = (m) => m?.interactive?.action?.buttons?.map((b) => b.reply.id) ?? [];
const listRowIds = (m) => m?.interactive?.action?.sections?.flatMap((s) => s.rows.map((r) => r.id)) ?? [];

async function cleanup() {
  await pool.query(
    `DELETE so FROM slot_offers so
       JOIN appointments a ON a.id = so.source_appointment_id
      WHERE a.patient_phone IN (?)`,
    [ALL_PHONES],
  );
  await pool.query('DELETE FROM slot_offers WHERE source_appointment_id IS NULL');
  await pool.query("DELETE FROM slot_offers WHERE location = 'smoke_loc'");
  await pool.query(
    `DELETE w FROM waitlist w
       JOIN appointments a ON a.id = w.appointment_id
      WHERE a.patient_phone IN (?)`,
    [ALL_PHONES],
  );
  await pool.query('DELETE FROM conversations WHERE phone IN (?)', [ALL_PHONES]);
  await pool.query('UPDATE appointments SET rescheduled_from_id = NULL WHERE patient_phone IN (?)', [ALL_PHONES]);
  await pool.query('DELETE FROM appointments WHERE patient_phone IN (?)', [ALL_PHONES]);
  await pool.query('DELETE FROM patients WHERE phone IN (?)', [ALL_PHONES]);
}

async function waitlistEntryFor(appointmentId) {
  const [rows] = await pool.query('SELECT id, status FROM waitlist WHERE appointment_id = ?', [appointmentId]);
  return rows[0] ?? null;
}

try {
  await cleanup();

  console.log('\n── Feature 2: info de llegada de Clínica Norte ──');

  await send(text('quiero agendar una cita'));
  await send(button('type_primera_vez'));
  await send(button('loc_norte'));

  let msg = lastTo(PHONE_A);
  expect('primera vez en Norte: llega el mensaje de indicaciones', msg?.interactive?.body?.text?.includes('CLÍNICA NORTE'), JSON.stringify(msg));
  expect('con botón Continuar (locinfo_continue)', buttonIds(msg).includes('locinfo_continue'));

  await send(text('¿qué?'));
  expect('input no reconocido: re-prompt suave', lastTo(PHONE_A)?.text?.body?.includes('Continuar'));

  await send(button('locinfo_continue'));
  msg = lastTo(PHONE_A);
  expect('al continuar: lista de fechas', msg?.interactive?.type === 'list' && msg.interactive.body.text.includes('fechas'), JSON.stringify(msg?.interactive?.body));

  console.log('\n── Agendado lejano → invitación a lista de espera ──');

  // Última fecha ofrecida (la más lejana) para garantizar el umbral.
  const dateRows = listRowIds(msg);
  await send(list(dateRows.at(-1)));
  const slotRows = listRowIds(lastTo(PHONE_A));
  expect('lista de horarios recibida', slotRows.length > 0 && slotRows[0].startsWith('slot_'));
  await send(list(slotRows[0]));
  await send(text('María Prueba Waitlist'));
  await send(text('no'));
  await send(button('confirm_yes'));

  const inviteMsg = lastTo(PHONE_A);
  const joinId = buttonIds(inviteMsg).find((id) => id.startsWith('wl_join_'));
  expect('tras crear la cita llega la invitación a la lista de espera', Boolean(joinId), JSON.stringify(inviteMsg));
  const apptAId = joinId?.slice('wl_join_'.length);
  const apptA = apptAId ? await appointmentRepository.getById(apptAId) : null;
  expect('la invitación referencia la cita recién creada', apptA?.patientPhone === PHONE_A && apptA?.status === 'pending');

  await send(button(joinId));
  expect('respuesta de "ya estás en la lista"', lastTo(PHONE_A)?.text?.body?.includes('lista de espera'));
  let entryA = await waitlistEntryFor(apptAId);
  expect('entrada de waitlist creada (waiting)', entryA?.status === 'waiting');

  await send(button(joinId));
  const [countRows] = await pool.query('SELECT COUNT(*) AS n FROM waitlist WHERE appointment_id = ?', [apptAId]);
  expect('botón repetido no duplica la entrada', countRows[0].n === 1);

  expect('umbral: cita a 8 días califica', waitlistService.qualifiesForWaitlist(addDays(new Date(), 8)));
  expect('umbral: cita a 1 día no califica', !waitlistService.qualifiesForWaitlist(addDays(new Date(), 1)));

  console.log('\n── Segunda vez en Norte: sin mensaje de info ──');

  await send(text('agendar'));
  await send(button('type_subsecuente'));
  await send(button('loc_norte'));
  msg = lastTo(PHONE_A);
  expect('ya con cita previa en Norte: directo a fechas', msg?.interactive?.type === 'list' && msg.interactive.body.text.includes('fechas'));
  await send(text('cancelar'));

  await send(text('agendar'));
  await send(button('type_subsecuente'));
  await send(button('loc_sur'));
  msg = lastTo(PHONE_A);
  expect('Sur no tiene firstVisitInfo: directo a fechas', msg?.interactive?.type === 'list' && msg.interactive.body.text.includes('fechas'));
  await send(text('cancelar'));

  console.log('\n── Cancelación libera hueco → aviso a la doctora ──');

  // Natalia (C): cita muy lejana insertada directo + entrada en la lista.
  const apptCId = randomUUID();
  await pool.query('INSERT IGNORE INTO patients (phone, name) VALUES (?, ?)', [PHONE_C, 'Natalia Prueba Waitlist']);
  await appointmentRepository.create({
    id: apptCId,
    patientPhone: PHONE_C,
    patientName: 'Natalia Prueba Waitlist',
    consultationType: 'subsecuente',
    location: 'norte',
    scheduledAt: addDays(new Date(), 20),
    durationMin: 40,
  });
  await send(button(`wl_join_${apptCId}`, PHONE_C));
  const entryC = await waitlistEntryFor(apptCId);
  expect('Natalia también en la lista de espera', entryC?.status === 'waiting');

  // Paulina (B): cita cercana (antes que las de A y C) que va a cancelar.
  const apptBId = randomUUID();
  await pool.query('INSERT IGNORE INTO patients (phone, name) VALUES (?, ?)', [PHONE_B, 'Paulina Prueba Waitlist']);
  await appointmentRepository.create({
    id: apptBId,
    patientPhone: PHONE_B,
    patientName: 'Paulina Prueba Waitlist',
    consultationType: 'subsecuente',
    location: 'sur',
    scheduledAt: addMinutes(new Date(), 30),
    durationMin: 40,
  });
  const apptB = await appointmentRepository.getById(apptBId);

  const doctorMsgsBefore = toDoctor().length;
  await cancelAppointment(apptB);
  expect('doctora notificada de la cancelación', toDoctor().some((m, i) => i >= doctorMsgsBefore && m.text?.body?.includes('canceló su cita')));

  const promptMsg = lastToDoctor();
  const viewId = buttonIds(promptMsg).find((id) => id.startsWith('wl_view_'));
  const skipId = buttonIds(promptMsg).find((id) => id.startsWith('wl_skip_'));
  expect('aviso de hueco liberado con botones Ver lista/Dejar libre', Boolean(viewId && skipId), JSON.stringify(promptMsg));
  expect('el botón de sesión dice "Ver lista de espera"', promptMsg?.interactive?.action?.buttons?.[0]?.reply?.title === 'Ver lista de espera');
  expect('el aviso menciona 2 candidatas', promptMsg?.interactive?.body?.text?.includes(': 2'));
  const offerId = viewId?.slice('wl_view_'.length);

  console.log('\n── La doctora ve la lista en texto y elige escribiendo el nombre ──');

  let doctorBefore = toDoctor().length;
  await send(button(viewId, DOCTOR));
  let listMsgs = toDoctor().slice(doctorBefore);
  let listText = listMsgs.map((m) => m.text?.body ?? '').join('\n');
  expect('la lista llega como texto libre (sin List Message)', listMsgs.length >= 1 && listMsgs.every((m) => m.type === 'text'), JSON.stringify(listMsgs));
  expect('la lista incluye a María y a Natalia', listText.includes('1. María Prueba Waitlist') && listText.includes('2. Natalia Prueba Waitlist'), listText);
  expect('orden cronológico (cita más cercana primero)', listText.indexOf('María Prueba') < listText.indexOf('Natalia Prueba'));
  expect('pide escribir el nombre', listText.includes('Escribe el nombre de una paciente para saber más detalles'));
  let [browseRows] = await pool.query('SELECT doctor_browsed_at FROM slot_offers WHERE id = ?', [offerId]);
  expect('la oferta queda marcada como lista abierta', Boolean(browseRows[0]?.doctor_browsed_at));

  await send(text('Natalia', DOCTOR));
  let detail = lastToDoctor();
  let detailBody = detail?.interactive?.body?.text ?? '';
  expect('"Natalia" → detalle de Natalia', detailBody.includes('Natalia Prueba Waitlist'), JSON.stringify(detail));
  expect('detalle con botones Ofrecerle horario / Dejar libre',
    buttonIds(detail).includes(`wl_pick_${offerId}_${entryC.id}`) && buttonIds(detail).includes(`wl_skip_${offerId}`));
  expect('detalle con teléfono, tipo de consulta y cita actual',
    detailBody.includes(`+${PHONE_C}`) && detailBody.includes('Consulta subsecuente') && detailBody.includes('Su cita actual'));
  expect('detalle invita a escribir otro nombre', detailBody.includes('O escribe el nombre de otra paciente para seleccionarla'));

  await send(text('maría prueba', DOCTOR));
  expect('otro nombre (sin acento) → detalle de María', buttonIds(lastToDoctor()).includes(`wl_pick_${offerId}_${entryA.id}`));

  await send(text('2', DOCTOR));
  expect('número de la lista → detalle de esa paciente', buttonIds(lastToDoctor()).includes(`wl_pick_${offerId}_${entryC.id}`));

  await send(text('Prueba Waitlist', DOCTOR));
  const ambiguous = lastToDoctor()?.text?.body ?? '';
  expect('nombre ambiguo → pide precisar, con ambas y su número', ambiguous.includes('varias pacientes') && ambiguous.includes('1. María') && ambiguous.includes('2. Natalia'), ambiguous);

  await send(text('Zoila Inexistente', DOCTOR));
  expect('nombre que no está → aviso con pista', lastToDoctor()?.text?.body?.includes('No encontré a "Zoila Inexistente"'));

  await send(text('ayuda', DOCTOR));
  expect('los comandos globales siguen funcionando con la lista abierta', lastToDoctor()?.text?.body?.includes('¿Cómo funciono?'));

  await send(button(`wl_pick_${offerId}_${entryC.id}`, DOCTOR));
  const offerToC = lastTo(PHONE_C);
  const acceptId = buttonIds(offerToC).find((id) => id.startsWith('wloffer_accept_'));
  expect('Natalia recibe la oferta con botones', Boolean(acceptId), JSON.stringify(offerToC));
  expect('la doctora ve "le ofrecí el horario"', lastToDoctor()?.text?.body?.includes('Le ofrecí el horario a Natalia'));
  const [offerMsgRows] = await pool.query('SELECT offer_message_id FROM slot_offers WHERE id = ?', [offerId]);
  expect('se guarda el wamid de la oferta (seguimiento de entrega)', offerMsgRows[0]?.offer_message_id?.startsWith('wamid.stub.'));

  const doctorMsgsWhileOffered = toDoctor().length;
  await send(text('María', DOCTOR));
  const afterOffered = toDoctor().slice(doctorMsgsWhileOffered);
  expect('con la oferta en manos de la paciente, el texto de la doctora ya no se toma como nombre para ese hueco',
    !afterOffered.some((m) => buttonIds(m).some((id) => id.startsWith('wl_pick_'))));
  // Revisión 25/09: sin lista de hueco abierta, el nombre se busca en la lista completa.
  expect('…sino que se busca en la lista completa (detalle con "Buscarle horario")',
    afterOffered.some((m) => buttonIds(m).some((id) => id.startsWith('wl_slots_'))));

  await send(button(`wloffer_decline_${offerId}`, PHONE_C));
  expect('Natalia: confirmación de rechazo sin perder su cita', lastTo(PHONE_C)?.text?.body?.includes('sigue en pie'));
  const rePrompt = lastToDoctor();
  expect('doctora recibe re-oferta tras el rechazo', rePrompt?.interactive?.body?.text?.includes('no aceptó') && buttonIds(rePrompt).includes(viewId), JSON.stringify(rePrompt));

  doctorBefore = toDoctor().length;
  await send(button(viewId, DOCTOR));
  listText = toDoctor().slice(doctorBefore).map((m) => m.text?.body ?? '').join('\n');
  expect('Natalia ya no aparece; María sigue', !listText.includes('Natalia Prueba') && listText.includes('1. María Prueba Waitlist'), listText);

  await send(text('Natalia', DOCTOR));
  expect('Natalia (ya rechazó este hueco) no se encuentra', lastToDoctor()?.text?.body?.includes('No encontré a "Natalia"'));

  console.log('\n── María acepta: swap de cita ──');

  await send(text('María', DOCTOR));
  await send(button(`wl_pick_${offerId}_${entryA.id}`, DOCTOR));
  const offerToA = lastTo(PHONE_A);
  expect('María recibe la oferta', buttonIds(offerToA).includes(`wloffer_accept_${offerId}`), JSON.stringify(offerToA));

  await send(button(`wloffer_accept_${offerId}`, PHONE_A));
  expect('María: confirmación de nuevo horario', lastTo(PHONE_A)?.text?.body?.includes('Tu cita quedó para'));

  const activeA = await appointmentRepository.getActiveByPhone(PHONE_A);
  const movedA = activeA.find((a) => a.rescheduledFromId === apptAId);
  expect('cita nueva de María en el hueco de Paulina', movedA
    && new Date(movedA.scheduledAt).getTime() === new Date(apptB.scheduledAt).getTime()
    && movedA.location === 'sur', JSON.stringify(activeA));
  expect('cita vieja de María en rescheduled', (await appointmentRepository.getById(apptAId))?.status === 'rescheduled');

  const [offerRows] = await pool.query('SELECT status FROM slot_offers WHERE id = ?', [offerId]);
  expect('oferta marcada accepted', offerRows[0]?.status === 'accepted');
  entryA = await waitlistEntryFor(apptAId);
  expect('entrada de María fulfilled', entryA?.status === 'fulfilled');
  expect('doctora notificada del cambio', lastToDoctor()?.text?.body?.includes('reagendó su cita'));

  const activeCountBefore = (await appointmentRepository.getActiveByPhone(PHONE_A)).length;
  await send(button(`wloffer_accept_${offerId}`, PHONE_A));
  expect('aceptar dos veces no duplica la cita', (await appointmentRepository.getActiveByPhone(PHONE_A)).length === activeCountBefore);

  await send(text('hola', DOCTOR));
  expect('sin lista abierta, el texto de la doctora sigue el ruteo normal', lastToDoctor()?.text?.body?.includes('Hola'));

  console.log('\n── Dejar libre y validaciones ──');

  const apptB2Id = randomUUID();
  await appointmentRepository.create({
    id: apptB2Id,
    patientPhone: PHONE_B,
    patientName: 'Paulina Prueba Waitlist',
    consultationType: 'subsecuente',
    location: 'sur',
    scheduledAt: addMinutes(new Date(), 120),
    durationMin: 40,
  });
  await cancelAppointment(await appointmentRepository.getById(apptB2Id), { notifyDoctor: false });
  const prompt2 = lastToDoctor();
  const skip2 = buttonIds(prompt2).find((id) => id.startsWith('wl_skip_'));
  expect('segundo hueco genera nueva oferta (queda Natalia)', Boolean(skip2), JSON.stringify(prompt2));

  const patientMsgsBefore = to(PHONE_A).length;
  await send(button(skip2.replace('wl_skip_', 'wl_view_'), PHONE_A));
  expect('payload de doctora desde una paciente se ignora', to(PHONE_A).length === patientMsgsBefore);

  await send(button(skip2, DOCTOR));
  expect('doctora deja el hueco libre', lastToDoctor()?.text?.body?.includes('dejo el horario libre'));
  const offer2Id = skip2.slice('wl_skip_'.length);
  const [offer2Rows] = await pool.query('SELECT status FROM slot_offers WHERE id = ?', [offer2Id]);
  expect('oferta 2 cerrada', offer2Rows[0]?.status === 'closed');

  await send(button(skip2, DOCTOR));
  expect('botón sobre oferta cerrada: aviso de inactiva', lastToDoctor()?.text?.body?.includes('ya no está activo'));

  console.log(`\n── Lista larga: ${SEED_COUNT} pacientes en espera ──`);

  const seedIds = [];
  for (const [i, phone] of SEED_PHONES.entries()) {
    const name = `Paciente Semilla ${String(i + 1).padStart(2, '0')} Apellido Largo`;
    const id = randomUUID();
    seedIds.push(id);
    await pool.query('INSERT IGNORE INTO patients (phone, name) VALUES (?, ?)', [phone, name]);
    await appointmentRepository.create({
      id,
      patientPhone: phone,
      patientName: name,
      consultationType: i % 2 === 0 ? 'primera_vez' : 'subsecuente',
      location: i % 2 === 0 ? 'norte' : 'sur',
      // Orden cronológico inverso al de inserción, para probar el ORDER BY.
      scheduledAt: addMinutes(addDays(new Date(), 30), (SEED_COUNT - i) * 60),
      durationMin: 40,
      patientNotes: i === 0 ? 'x'.repeat(900) : null,
    });
    await waitlistRepository.addEntry({ id: randomUUID(), appointmentId: id });
  }

  const apptB3Id = randomUUID();
  await appointmentRepository.create({
    id: apptB3Id,
    patientPhone: PHONE_B,
    patientName: 'Paulina Prueba Waitlist',
    consultationType: 'subsecuente',
    location: 'norte',
    scheduledAt: addMinutes(new Date(), 180),
    durationMin: 40,
  });
  await cancelAppointment(await appointmentRepository.getById(apptB3Id), { notifyDoctor: false });
  const prompt3 = lastToDoctor();
  const view3 = buttonIds(prompt3).find((id) => id.startsWith('wl_view_'));
  expect('hueco con lista larga: aviso con el total', prompt3?.interactive?.body?.text?.includes(`: ${SEED_COUNT + 1}`), JSON.stringify(prompt3?.interactive?.body));

  doctorBefore = toDoctor().length;
  await send(button(view3, DOCTOR));
  const longMsgs = toDoctor().slice(doctorBefore);
  const longText = longMsgs.map((m) => m.text?.body ?? '').join('\n');
  expect('lista larga partida en varios mensajes de texto', longMsgs.length >= 2 && longMsgs.every((m) => m.type === 'text'), `mensajes: ${longMsgs.length}`);
  expect('cada mensaje respeta el límite de 4096', longMsgs.every((m) => Array.from(m.text.body).length <= 4096));
  const numbered = [...longText.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  expect(`las ${SEED_COUNT + 1} pacientes aparecen, numeradas en orden`, numbered.length === SEED_COUNT + 1 && numbered.every((n, i) => n === i + 1), `numeradas: ${numbered.length}`);
  expect('orden cronológico con datos sembrados en orden inverso', longText.indexOf('Semilla 70') < longText.indexOf('Semilla 01'));
  expect('el cierre "Escribe el nombre..." va en el último mensaje', longMsgs.at(-1).text.body.includes('Escribe el nombre de una paciente'));

  await send(text('semilla 01', DOCTOR));
  const longDetail = lastToDoctor();
  expect('detalle con notas largas truncadas dentro del límite de 1024',
    longDetail?.type === 'interactive' && Array.from(longDetail.interactive.body.text).length <= 1024 && longDetail.interactive.body.text.includes('…'),
    JSON.stringify(longDetail).slice(0, 200));
  const view3Id = view3.slice('wl_view_'.length);
  await send(button(`wl_skip_${view3Id}`, DOCTOR));

  console.log('\n── Limpieza de la lista de espera ──');

  // Entrada de una cita que ya pasó y entrada de una cita cancelada.
  await pool.query('UPDATE appointments SET scheduled_at = ? WHERE id = ?', [addDays(new Date(), -1), seedIds[0]]);
  await pool.query("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [seedIds[1]]);
  const purged = await waitlistRepository.purgeStaleEntries();
  const [stale] = await pool.query('SELECT COUNT(*) AS n FROM waitlist WHERE appointment_id IN (?)', [[seedIds[0], seedIds[1]]]);
  const [alive] = await pool.query('SELECT COUNT(*) AS n FROM waitlist WHERE appointment_id = ?', [seedIds[2]]);
  expect('purga: borra entradas de citas pasadas y canceladas', purged >= 2 && stale[0].n === 0, `purgadas: ${purged}`);
  expect('purga: conserva las entradas vigentes', alive[0].n === 1);

  const expiredOfferId = randomUUID();
  await waitlistRepository.createOffer({
    id: expiredOfferId,
    sourceAppointmentId: null,
    location: 'smoke_loc',
    scheduledAt: addDays(new Date(), -1),
    durationMin: 40,
  });
  await waitlistRepository.closeExpiredOffers();
  const expired = await waitlistRepository.getOfferById(expiredOfferId);
  expect('ofertas con el hueco en el pasado se cierran', expired?.status === 'closed');
} catch (err) {
  failed += 1;
  console.error('\n💥 Error inesperado en el smoke test:', err);
} finally {
  await cleanup();
  await closeDb();
}

console.log(`\nResultado: ${passed} pass / ${failed} fail · ${sentMessages.length} mensajes salientes simulados`);
process.exit(failed === 0 ? 0 : 1);
