/**
 * Smoke test de la lista de espera a voluntad (revisión de la doctora, 25/09):
 * la doctora escribe "lista de espera", elige a una paciente por nombre, le
 * busca un horario (ambos consultorios, antes de su cita) y se lo ofrece sin
 * que nadie haya cancelado. De ahí en adelante es el ciclo normal de oferta.
 *
 * Igual que smoke-waitlist.js: messageHandler y MySQL reales, Graph API
 * stubbeada, calendarios fuera (disponibilidad solo con MySQL).
 *
 * Uso: node scripts/smoke-waitlist-ondemand.js
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
process.env.NOTIFY_RESCHEDULE = 'true';

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
    json: async () => ({ messages: [{ id: `wamid.stub.od.${wamidCounter}` }] }),
  };
};

const { config } = await import('../src/config/index.js');
const { handleIncomingMessage } = await import('../src/handlers/messageHandler.js');
const appointmentRepository = await import('../src/services/appointmentRepository.js');
const waitlistRepository = await import('../src/services/waitlistRepository.js');
const stateManager = await import('../src/services/stateManager.js');
const { getAvailableDates, getAvailableSlots, slotToUtc } = await import('../src/services/availabilityService.js');
const { addDays, addMinutes } = await import('../src/lib/dates.js');
const { pool, closeDb } = await import('../src/db/connection.js');
const { randomUUID } = await import('node:crypto');

// Teléfonos ficticios solo para este smoke test.
const PHONE_ROCIO = '5215599993001';  // cita cercana en Sur — la primera en ofrecérsele
const PHONE_PAOLA1 = '5215599993002'; // cita lejana — acepta al final
const PHONE_PAOLA2 = '5215599993003'; // homónima parcial (búsqueda ambigua)
const PHONE_ZOE = '5215599993004';    // en la lista pero con la cita cancelada
const PHONE_XIMENA = '5215599993005'; // cita en unos minutos: sin días antes
const PHONE_OTHER = '5215599993006';  // paciente que ocupa un horario a media elección
const ALL_PHONES = [PHONE_ROCIO, PHONE_PAOLA1, PHONE_PAOLA2, PHONE_ZOE, PHONE_XIMENA, PHONE_OTHER];

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
    from: DOCTOR,
    profileName: 'Smoke Ondemand',
    waId: DOCTOR,
    messageId: `wamid.in.od.${inboundCounter}`,
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
const text = (t, from = DOCTOR) => baseMessage({ text: t, from, waId: from });
const list = (id, from = DOCTOR) => baseMessage({ inputType: 'list', rawType: 'interactive', listId: id, from, waId: from });
const button = (id, from = DOCTOR) => baseMessage({ inputType: 'button', rawType: 'interactive', buttonPayload: id, from, waId: from });

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
const bodyOf = (m) => m?.text?.body ?? m?.interactive?.body?.text ?? '';
const buttonIds = (m) => m?.interactive?.action?.buttons?.map((b) => b.reply.id) ?? [];
const listRows = (m) => m?.interactive?.action?.sections?.flatMap((s) => s.rows) ?? [];
const doctorSince = (n) => toDoctor().slice(n);

async function cleanup() {
  await pool.query(
    `DELETE so FROM slot_offers so
       JOIN waitlist w ON w.id = so.offered_waitlist_id
       JOIN appointments a ON a.id = w.appointment_id
      WHERE a.patient_phone IN (?)`,
    [ALL_PHONES],
  );
  await pool.query(
    `DELETE so FROM slot_offers so
       JOIN appointments a ON a.id = so.source_appointment_id
      WHERE a.patient_phone IN (?)`,
    [ALL_PHONES],
  );
  await pool.query('DELETE FROM slot_offers WHERE source_appointment_id IS NULL');
  await pool.query(
    `DELETE w FROM waitlist w
       JOIN appointments a ON a.id = w.appointment_id
      WHERE a.patient_phone IN (?)`,
    [ALL_PHONES],
  );
  await pool.query('DELETE FROM conversations WHERE phone IN (?)', [[...ALL_PHONES, DOCTOR]]);
  await pool.query('UPDATE appointments SET rescheduled_from_id = NULL WHERE patient_phone IN (?)', [ALL_PHONES]);
  await pool.query('DELETE FROM appointments WHERE patient_phone IN (?)', [ALL_PHONES]);
  await pool.query('DELETE FROM patients WHERE phone IN (?)', [ALL_PHONES]);
}

/** Cita + entrada en la lista de espera, insertadas directo. */
async function seedWaiting({ phone, name, location, scheduledAt, status = 'pending' }) {
  const appointmentId = randomUUID();
  const waitlistId = randomUUID();
  await pool.query('INSERT IGNORE INTO patients (phone, name) VALUES (?, ?)', [phone, name]);
  await appointmentRepository.create({
    id: appointmentId,
    patientPhone: phone,
    patientName: name,
    consultationType: 'subsecuente',
    location,
    scheduledAt,
    durationMin: 40,
  });
  if (status !== 'pending') {
    await pool.query('UPDATE appointments SET status = ? WHERE id = ?', [status, appointmentId]);
  }
  await waitlistRepository.addEntry({ id: waitlistId, appointmentId });
  return { appointmentId, waitlistId };
}

try {
  await cleanup();

  // ── Datos: Rocío con cita en un martes/jueves de Sur a ≥4 días (así
  // hay días de Norte antes), en su 3er horario libre de ese día.
  const surDays = await getAvailableDates({ location: 'sur', durationMin: 40, maxDates: 10 });
  const rocioDay = surDays.find((d) => slotToUtc(d.date, d.slots[0]) > addDays(new Date(), 4) && d.slots.length >= 3);
  if (!rocioDay) throw new Error('No hay un día de Sur adecuado para el smoke (revisa la disponibilidad local)');
  const rocioAt = slotToUtc(rocioDay.date, rocioDay.slots[2]);

  const rocio = await seedWaiting({ phone: PHONE_ROCIO, name: 'Rocío Ondemand Tres', location: 'sur', scheduledAt: rocioAt });
  const paola1 = await seedWaiting({ phone: PHONE_PAOLA1, name: 'Paola Ondemand Uno', location: 'norte', scheduledAt: addDays(new Date(), 40) });
  const paola2 = await seedWaiting({ phone: PHONE_PAOLA2, name: 'Paola Ondemand Dos', location: 'norte', scheduledAt: addDays(new Date(), 45) });
  const zoe = await seedWaiting({ phone: PHONE_ZOE, name: 'Zoe Ondemand Cuatro', location: 'norte', scheduledAt: addDays(new Date(), 30), status: 'cancelled' });
  const ximena = await seedWaiting({ phone: PHONE_XIMENA, name: 'Ximena Ondemand Cinco', location: 'norte', scheduledAt: addMinutes(new Date(), 5) });

  console.log('\n── Comando "lista de espera" ──');

  let before = sentMessages.length;
  await send(text('lista de espera', PHONE_PAOLA1));
  expect('una paciente que escribe "lista de espera" NO recibe la lista',
    !sentMessages.slice(before).some((m) => bodyOf(m).includes('*Lista de espera* —')));
  expect('…y a la doctora no le llega nada', !sentMessages.slice(before).some((m) => m.to === DOCTOR));

  // Una lista de hueco abierta y un flujo activo: el comando le gana a ambos.
  const browsingOfferId = randomUUID();
  await waitlistRepository.createOffer({
    id: browsingOfferId, sourceAppointmentId: null, location: 'norte',
    scheduledAt: addDays(new Date(), 2), durationMin: 40,
  });
  await waitlistRepository.markOfferBrowsed(browsingOfferId);
  await stateManager.setState(DOCTOR, { currentStep: 'SELECTING_TYPE', flowType: 'appointment', contextData: {} });

  let doctorMark = toDoctor().length;
  await send(text('¿Me muestras la lista de espera?'));
  const listText = doctorSince(doctorMark).map(bodyOf).join('\n');
  expect('la doctora recibe la lista completa', listText.includes('*Lista de espera* —'), listText.slice(0, 200));
  expect('con el cierre "Escribe el nombre…"', listText.includes('Escribe el nombre de una paciente'));
  const iRocio = listText.indexOf('Rocío Ondemand Tres');
  const iPaola1 = listText.indexOf('Paola Ondemand Uno');
  const iPaola2 = listText.indexOf('Paola Ondemand Dos');
  expect('en orden de su cita (Rocío → Paola Uno → Paola Dos)', iRocio > -1 && iRocio < iPaola1 && iPaola1 < iPaola2);
  expect('sin la paciente con la cita cancelada', !listText.includes('Zoe Ondemand'));
  expect('el comando limpia el flujo activo de la doctora', (await stateManager.getState(DOCTOR)) === null);
  const [browsingRows] = await pool.query('SELECT doctor_browsed_at FROM slot_offers WHERE id = ?', [browsingOfferId]);
  expect('…y cierra la lista de hueco que tenía abierta', browsingRows[0]?.doctor_browsed_at === null);
  await pool.query('DELETE FROM slot_offers WHERE id = ?', [browsingOfferId]);

  const [otherWaiting] = await pool.query(
    `SELECT COUNT(*) AS n FROM waitlist w JOIN appointments a ON a.id = w.appointment_id
      WHERE w.status = 'waiting' AND a.status IN ('pending','confirmed') AND a.scheduled_at > NOW()
        AND a.patient_phone NOT IN (?)`,
    [ALL_PHONES],
  );
  if (otherWaiting[0].n === 0) {
    await pool.query('UPDATE waitlist SET status = ? WHERE id IN (?)', ['fulfilled', [rocio.waitlistId, paola1.waitlistId, paola2.waitlistId, ximena.waitlistId]]);
    doctorMark = toDoctor().length;
    await send(text('ver lista de espera'));
    expect('lista vacía: aviso claro', bodyOf(lastToDoctor()).includes('está vacía'));
    await pool.query('UPDATE waitlist SET status = ? WHERE id IN (?)', ['waiting', [rocio.waitlistId, paola1.waitlistId, paola2.waitlistId, ximena.waitlistId]]);
  } else {
    console.log('  (lista vacía no probada: la DB local tiene otras pacientes en espera)');
  }

  console.log('\n── Nombre escrito → detalle (lista completa) ──');

  await send(text('rocio'));
  let msg = lastToDoctor();
  expect('"rocio" → detalle de Rocío', bodyOf(msg).includes('Rocío Ondemand Tres') && bodyOf(msg).includes('Su cita actual'), bodyOf(msg));
  expect('con la pregunta de buscarle horario', bodyOf(msg).includes('¿Le busco un horario'));
  expect('botón "Buscarle horario" (wl_slots_)', buttonIds(msg).includes(`wl_slots_${rocio.waitlistId}`));

  await send(text('paola ondemand'));
  msg = lastToDoctor();
  expect('nombre compartido → lista de coincidencias', bodyOf(msg).includes('Encontré varias') && bodyOf(msg).includes('Paola Ondemand Uno') && bodyOf(msg).includes('Paola Ondemand Dos'));

  const entries = await waitlistRepository.getWaitingEntries();
  const rocioNumber = entries.findIndex((e) => e.id === rocio.waitlistId) + 1;
  await send(text(String(rocioNumber)));
  expect('su número de la lista → detalle', buttonIds(lastToDoctor()).includes(`wl_slots_${rocio.waitlistId}`));

  await send(text('Zzz Inexistente'));
  expect('nombre que no está → pista para ver la lista', bodyOf(lastToDoctor()).includes('No reconocí "Zzz Inexistente"') && bodyOf(lastToDoctor()).includes('lista de espera'));

  await send(text('hola'));
  expect('"hola" sigue siendo saludo (no búsqueda)', bodyOf(lastToDoctor()).includes('Soy la asistente'));

  console.log('\n── Buscarle horario → días → horas ──');

  await send(button(`wl_slots_${rocio.waitlistId}`));
  msg = lastToDoctor();
  let rows = listRows(msg);
  expect('lista de días', msg?.interactive?.type === 'list' && rows.length > 0, JSON.stringify(msg).slice(0, 300));
  expect('≤10 días', rows.length <= 10);
  expect('todas las filas son wl_date_ de Rocío', rows.every((r) => r.id.startsWith(`wl_date_${rocio.waitlistId}_`)));
  const rowDates = rows.map((r) => {
    const [, loc, date] = /_([a-z_]+)_(\d{2}\/\d{2}\/\d{4})$/.exec(r.id);
    return { loc, date, at: slotToUtc(date, '00:00') };
  });
  expect('solo días hasta su cita', rowDates.every((d) => d.at <= slotToUtc(rocioDay.date, '00:00')));
  expect('en orden de fecha', rowDates.every((d, i) => i === 0 || rowDates[i - 1].at <= d.at));
  expect('de ambos consultorios', rowDates.some((d) => d.loc === 'norte') && rowDates.some((d) => d.loc === 'sur'));
  expect('descripción con consultorio y número de horarios', rows.every((r) => /· \d+ horarios?$/.test(r.description ?? '')));
  expect('incluye el día de su cita (horarios antes de su hora)', rowDates.some((d) => d.loc === 'sur' && d.date === rocioDay.date));

  await send(list(`wl_date_${rocio.waitlistId}_sur_${rocioDay.date}`));
  msg = lastToDoctor();
  const expectedSameDay = (await getAvailableSlots({ location: 'sur', date: rocioDay.date, durationMin: 40 }))
    .filter((t) => slotToUtc(rocioDay.date, t) < rocioAt);
  const sameDayTimes = listRows(msg).map((r) => r.id.slice(r.id.lastIndexOf('_') + 1));
  expect('el día de su cita: solo horarios antes de su hora',
    JSON.stringify(sameDayTimes) === JSON.stringify(expectedSameDay), `${sameDayTimes} vs ${expectedSameDay}`);

  // Paginación: un día de Sur de Paola Uno (cita lejana) con >10 horarios.
  const paolaDays = await getAvailableDates({ location: 'sur', durationMin: 40, maxDates: 10 });
  const longDay = paolaDays.find((d) => d.slots.length > 10);
  if (longDay) {
    await send(list(`wl_date_${paola1.waitlistId}_sur_${longDay.date}`));
    const page1 = listRows(lastToDoctor());
    const moreId = page1.find((r) => r.id.startsWith('wl_tpage_'))?.id;
    expect('día largo: 9 horarios + "Ver más horarios"', page1.length === 10 && Boolean(moreId), JSON.stringify(page1.map((r) => r.id.slice(-12))));
    await send(list(moreId));
    const page2 = listRows(lastToDoctor());
    expect('página 2 con el resto de horarios', page2.length === longDay.slots.length - 9
      && page2.every((r) => r.id.startsWith(`wl_time_${paola1.waitlistId}_sur_${longDay.date}_`)));
  } else {
    console.log('  (paginación no probada: ningún día de Sur con >10 horarios libres)');
  }

  console.log('\n── Hora → confirmación → oferta ──');

  const offerTime = expectedSameDay[0];
  const offerAt = slotToUtc(rocioDay.date, offerTime);
  await send(list(`wl_time_${rocio.waitlistId}_sur_${rocioDay.date}_${offerTime}`));
  msg = lastToDoctor();
  const sendId = `wl_send_${rocio.waitlistId}_sur_${rocioDay.date}_${offerTime}`;
  expect('confirmación antes de escribirle a la paciente', bodyOf(msg).includes('¿Le ofrezco a *Rocío Ondemand Tres*'));
  expect('botones "Sí, ofrecérselo" / "Otro horario"', buttonIds(msg).includes(sendId) && buttonIds(msg).includes(`wl_slots_${rocio.waitlistId}`));
  expect('todavía no se le escribe a Rocío', to(PHONE_ROCIO).length === 0);

  await send(button(sendId));
  const [offerRows] = await pool.query(
    'SELECT id, status, source_appointment_id, offered_waitlist_id, offer_message_id FROM slot_offers WHERE location = ? AND scheduled_at = ?',
    ['sur', offerAt],
  );
  const manualOffer = offerRows[0];
  expect('se crea UNA oferta sin cita de origen', offerRows.length === 1 && manualOffer.source_appointment_id === null);
  expect('en manos de Rocío', manualOffer?.status === 'offered_patient' && manualOffer.offered_waitlist_id === rocio.waitlistId);
  expect('Rocío recibe la oferta con botones', buttonIds(lastTo(PHONE_ROCIO)).includes(`wloffer_accept_${manualOffer?.id}`));
  expect('se guarda el wamid de la oferta', manualOffer?.offer_message_id?.startsWith('wamid.stub.od.'));
  expect('la doctora ve "Le ofrecí el horario a Rocío"', bodyOf(lastToDoctor()).includes('Le ofrecí el horario a Rocío'));

  const rocioMsgs = to(PHONE_ROCIO).length;
  await send(button(sendId));
  expect('doble tap: no se le manda otra oferta', to(PHONE_ROCIO).length === rocioMsgs);
  expect('…y la doctora ve que sigue esperando su respuesta', bodyOf(lastToDoctor()).includes('Ya le ofreciste a Rocío'));
  await send(button(`wl_slots_${rocio.waitlistId}`));
  expect('"Buscarle horario" con oferta pendiente → mismo aviso', bodyOf(lastToDoctor()).includes('Ya le ofreciste a Rocío'));

  const paolaMsgs = to(PHONE_PAOLA1).length;
  await send(button(`wl_send_${paola1.waitlistId}_sur_${rocioDay.date}_${offerTime}`));
  expect('el mismo horario a otra paciente mientras Rocío decide → bloqueado', bodyOf(lastToDoctor()).includes('ya se lo ofreciste a Rocío'));
  expect('Paola Uno no recibe nada', to(PHONE_PAOLA1).length === paolaMsgs);

  console.log('\n── Rechazo → regresa a la doctora; se reusa la oferta ──');

  doctorMark = toDoctor().length;
  await send(button(`wloffer_decline_${manualOffer.id}`, PHONE_ROCIO));
  msg = doctorSince(doctorMark).at(-1);
  expect('rechazo: la doctora recibe el aviso de siempre', buttonIds(msg).includes(`wl_view_${manualOffer.id}`), JSON.stringify(msg).slice(0, 300));
  expect('con la redacción nueva ("el horario que le ofreciste")', bodyOf(msg).includes('no aceptó el horario que le ofreciste'));

  await send(button(`wl_send_${paola1.waitlistId}_sur_${rocioDay.date}_${offerTime}`));
  const [reuseRows] = await pool.query(
    'SELECT id, status, offered_waitlist_id FROM slot_offers WHERE location = ? AND scheduled_at = ?',
    ['sur', offerAt],
  );
  expect('a voluntad sobre un horario con oferta abierta: se reusa (sin duplicar)', reuseRows.length === 1 && reuseRows[0].id === manualOffer.id);
  expect('…ahora en manos de Paola Uno', reuseRows[0]?.status === 'offered_patient' && reuseRows[0].offered_waitlist_id === paola1.waitlistId);

  doctorMark = toDoctor().length;
  await send(button(`wloffer_accept_${manualOffer.id}`, PHONE_PAOLA1));
  const [movedRows] = await pool.query(
    `SELECT id, status, location, scheduled_at, rescheduled_from_id FROM appointments
      WHERE patient_phone = ? ORDER BY created_at`,
    [PHONE_PAOLA1],
  );
  const oldPaola = movedRows.find((r) => r.id === paola1.appointmentId);
  const newPaola = movedRows.find((r) => r.rescheduled_from_id === paola1.appointmentId);
  expect('acepta: su cita vieja queda reagendada', oldPaola?.status === 'rescheduled');
  expect('…y la nueva es el horario ofrecido (Sur)', newPaola && new Date(newPaola.scheduled_at).getTime() === offerAt.getTime() && newPaola.location === 'sur');
  expect('Paola recibe la confirmación', bodyOf(lastTo(PHONE_PAOLA1)).includes('¡Listo! Tu cita quedó'));
  expect('la doctora recibe el aviso de reagendado', doctorSince(doctorMark).some((m) => bodyOf(m).includes('reagendó su cita')));
  const [paolaEntry] = await pool.query('SELECT status FROM waitlist WHERE id = ?', [paola1.waitlistId]);
  expect('su entrada de la lista queda cumplida', paolaEntry[0]?.status === 'fulfilled');

  console.log('\n── Taps viejos y casos límite ──');

  await send(button(`wl_slots_${zoe.waitlistId}`));
  expect('paciente con la cita cancelada → "ya no está en la lista"', bodyOf(lastToDoctor()).includes('ya no está en la lista de espera'));

  await send(button(`wl_slots_${ximena.waitlistId}`));
  expect('cita en minutos → no hay horarios antes', bodyOf(lastToDoctor()).includes('No hay horarios libres antes de la cita de Ximena'));

  // Horario que se ocupa entre que la doctora lo ve y lo toca.
  const takenTime = expectedSameDay.find((t) => t !== offerTime);
  if (takenTime) {
    await send(list(`wl_date_${paola2.waitlistId}_sur_${rocioDay.date}`));
    await pool.query('INSERT IGNORE INTO patients (phone, name) VALUES (?, ?)', [PHONE_OTHER, 'Otra Ondemand Seis']);
    await appointmentRepository.create({
      id: randomUUID(),
      patientPhone: PHONE_OTHER,
      patientName: 'Otra Ondemand Seis',
      consultationType: 'subsecuente',
      location: 'sur',
      scheduledAt: slotToUtc(rocioDay.date, takenTime),
      durationMin: 40,
    });
    doctorMark = toDoctor().length;
    await send(list(`wl_time_${paola2.waitlistId}_sur_${rocioDay.date}_${takenTime}`));
    const replies = doctorSince(doctorMark);
    expect('horario ocupado a media elección → aviso', replies.some((m) => bodyOf(m).includes('Ese horario ya se ocupó')));
    expect('…y se reenvía el menú sin ese horario',
      !replies.flatMap(listRows).some((r) => r.id.endsWith(`_${takenTime}`)) && replies.some((m) => listRows(m).length > 0));
  }

  // Un día posterior a la cita de Rocío: sin horarios antes → menú de días.
  const laterDay = surDays.find((d) => slotToUtc(d.date, d.slots[0]) > rocioAt);
  if (laterDay) {
    const [rocioStill] = await pool.query('SELECT status FROM waitlist WHERE id = ?', [rocio.waitlistId]);
    if (rocioStill[0]?.status === 'waiting') {
      doctorMark = toDoctor().length;
      await send(list(`wl_date_${rocio.waitlistId}_sur_${laterDay.date}`));
      const replies = doctorSince(doctorMark);
      expect('día después de su cita → "ya no tiene horarios" + días', replies.some((m) => bodyOf(m).includes('Ese día ya no tiene horarios'))
        && replies.some((m) => listRows(m).some((r) => r.id.startsWith('wl_date_'))));
    }
  }

  before = sentMessages.length;
  await send(button(`wl_slots_${rocio.waitlistId}`, PHONE_PAOLA2));
  expect('payload de doctora desde otro número → ignorado', sentMessages.length === before);

  before = sentMessages.length;
  await send(list(`wl_date_${rocio.waitlistId}_narnia_${rocioDay.date}`));
  expect('consultorio desconocido en el payload → ignorado', sentMessages.length === before);
} catch (err) {
  failed += 1;
  console.error('\n💥 Error inesperado en el smoke:', err);
} finally {
  await cleanup().catch((err) => console.error('cleanup falló', err));
  console.log(`\nResultado: ${passed} pass / ${failed} fail · ${sentMessages.length} mensajes salientes simulados`);
  await closeDb();
  process.exit(failed > 0 ? 1 : 0);
}
