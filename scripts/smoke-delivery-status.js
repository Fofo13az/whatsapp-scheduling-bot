/**
 * Smoke test de los statuses de entrega de Meta (bug del 23/09: recordatorios
 * que Meta aceptó pero nunca entregó, sin que nadie se enterara).
 *
 * Recorre el camino real: POST al webhook (Express + router reales, en dev la
 * firma no se exige) → statusHandler → MySQL real, con la Graph API stubbeada.
 * Cubre: wamid guardado al enviar el recordatorio, statuses monótonos,
 * recordatorio fallido → aviso inmediato a la doctora (una sola vez) y fuera
 * del chequeo de no-respuesta, fallback doctor_reminder_undelivered →
 * doctor_alert cuando Meta aún no aprueba el template, carrera wamid/status,
 * y oferta de lista de espera no entregada → regresa a la doctora.
 *
 * Uso: node scripts/smoke-delivery-status.js
 */

import 'dotenv/config';

delete process.env.CALDAV_USERNAME;
delete process.env.CALDAV_APP_SPECIFIC_PASSWORD;
delete process.env.CALDAV_CALENDAR_NAME;
delete process.env.GOOGLE_CALENDAR_SUR;
delete process.env.GOOGLE_CALENDAR_NORTE;
delete process.env.WAITLIST_OFFER_TEMPLATE_NAME;
process.env.NODE_ENV = 'development';
process.env.REMINDER_TEMPLATE_NAME = 'appointment_reminder';
process.env.DOCTOR_TEMPLATES_ENABLED = 'true';
process.env.NOTIFY_NO_RESPONSE = 'true';

// ── Stub de la Graph API (el resto de fetch pasa: es el POST al webhook) ────
const realFetch = globalThis.fetch;
const graphCalls = [];
const unapprovedTemplates = new Set(); // templates que responden 132001
let wamidCounter = 0;

globalThis.fetch = async (url, options) => {
  if (!String(url).includes('graph.facebook.com')) return realFetch(url, options);
  const body = JSON.parse(options.body);
  graphCalls.push(body);
  if (body.type === 'template' && unapprovedTemplates.has(body.template.name)) {
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: { message: 'Template name does not exist in the translation', code: 132001, fbtrace_id: 'X' } }),
    };
  }
  wamidCounter += 1;
  return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.delivery.${wamidCounter}` }] }) };
};

const express = (await import('express')).default;
const { config } = await import('../src/config/index.js');
const { whatsappWebhookRouter } = await import('../src/webhook/whatsappWebhook.js');
const appointmentRepository = await import('../src/services/appointmentRepository.js');
const waitlistRepository = await import('../src/services/waitlistRepository.js');
const { runSendReminders } = await import('../src/scheduler/jobs/sendReminders.js');
const { runCheckNoResponses } = await import('../src/scheduler/jobs/checkNoResponses.js');
const { addDays, clinicTimeToUtc, getClinicParts } = await import('../src/lib/dates.js');
const { pool, closeDb } = await import('../src/db/connection.js');
const { randomUUID } = await import('node:crypto');

const PHONES = ['5215599993001', '5215599993002', '5215599993003', '5215599993004', '5215599993005'];
const [PHONE_READ, PHONE_FAILED, PHONE_UNAPPROVED, PHONE_LATE, PHONE_OFFER] = PHONES;

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

async function waitFor(check, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// Webhook real en un puerto efímero.
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use('/webhook/whatsapp', whatsappWebhookRouter);
const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const WEBHOOK_URL = `http://127.0.0.1:${server.address().port}/webhook/whatsapp`;

async function postStatus(status) {
  const response = await realFetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses: [status] } }] }],
    }),
  });
  return response.status;
}

const failedStatus = (id, recipient, code = 131026) => ({
  id,
  status: 'failed',
  timestamp: String(Math.floor(Date.now() / 1000)),
  recipient_id: recipient,
  errors: [{ code, title: 'Message undeliverable', message: 'Message undeliverable', error_data: { details: 'Message Undeliverable.' } }],
});

const doctorTemplates = (name) => graphCalls.filter((c) => c.type === 'template' && c.template.name === name);
const templateParams = (call) => call?.template?.components?.[0]?.parameters?.map((p) => p.text) ?? [];

async function cleanup() {
  await pool.query(
    `DELETE so FROM slot_offers so JOIN appointments a ON a.id = so.source_appointment_id WHERE a.patient_phone IN (?)`,
    [PHONES],
  );
  await pool.query("DELETE FROM slot_offers WHERE location = 'smoke_delivery'");
  await pool.query(
    `DELETE w FROM waitlist w JOIN appointments a ON a.id = w.appointment_id WHERE a.patient_phone IN (?)`,
    [PHONES],
  );
  await pool.query('DELETE FROM appointments WHERE patient_phone IN (?)', [PHONES]);
  await pool.query('DELETE FROM patients WHERE phone IN (?)', [PHONES]);
}

async function createAppointment(phone, name, scheduledAt, location = 'norte') {
  const id = randomUUID();
  await pool.query('INSERT IGNORE INTO patients (phone, name) VALUES (?, ?)', [phone, name]);
  await appointmentRepository.create({
    id,
    patientPhone: phone,
    patientName: name,
    consultationType: 'subsecuente',
    location,
    scheduledAt,
    durationMin: 40,
  });
  return id;
}

/** Mañana a las HH:MM en hora del consultorio (rango del job de recordatorios). */
function tomorrowAt(hour, minute = 0) {
  const tomorrow = getClinicParts(addDays(new Date(), 1));
  return clinicTimeToUtc({ ...tomorrow, hour, minute, second: 0 });
}

try {
  await cleanup();

  console.log('\n── El recordatorio guarda su wamid ──');

  const apptRead = await createAppointment(PHONE_READ, 'Rosa Entregada', tomorrowAt(9));
  const apptFailed = await createAppointment(PHONE_FAILED, 'Fernanda Fallida', tomorrowAt(10));
  const apptUnapproved = await createAppointment(PHONE_UNAPPROVED, 'Ursula Sin Template', tomorrowAt(11));

  await runSendReminders();
  let read = await appointmentRepository.getById(apptRead);
  let fail = await appointmentRepository.getById(apptFailed);
  const unapproved = await appointmentRepository.getById(apptUnapproved);
  expect('recordatorio enviado por template', graphCalls.some((c) => c.type === 'template' && c.template.name === 'appointment_reminder'));
  expect('se guarda el wamid del recordatorio', read.reminderMessageId?.startsWith('wamid.delivery.') && fail.reminderMessageId?.startsWith('wamid.delivery.'));
  expect('status de entrega en NULL hasta el primer acuse', read.reminderDeliveryStatus === null);

  console.log('\n── Statuses monótonos (sent → read, delivered tardío no retrocede) ──');

  expect('el webhook responde 200 a un status', (await postStatus({ id: read.reminderMessageId, status: 'sent', recipient_id: PHONE_READ })) === 200);
  expect('sent → reminder_delivery_status = sent', await waitFor(async () => (await appointmentRepository.getById(apptRead)).reminderDeliveryStatus === 'sent'));
  await postStatus({ id: read.reminderMessageId, status: 'read', recipient_id: PHONE_READ });
  expect('read → read', await waitFor(async () => (await appointmentRepository.getById(apptRead)).reminderDeliveryStatus === 'read'));
  await postStatus({ id: read.reminderMessageId, status: 'delivered', recipient_id: PHONE_READ });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect('delivered tardío no regresa el status', (await appointmentRepository.getById(apptRead)).reminderDeliveryStatus === 'read');

  console.log('\n── Recordatorio NO entregado → aviso inmediato a la doctora ──');

  const beforeUndelivered = doctorTemplates('doctor_reminder_undelivered').length;
  await postStatus(failedStatus(fail.reminderMessageId, PHONE_FAILED));
  expect('failed → status failed con el motivo guardado', await waitFor(async () => {
    const a = await appointmentRepository.getById(apptFailed);
    return a.reminderDeliveryStatus === 'failed' && a.reminderDeliveryError?.startsWith('131026 Message undeliverable');
  }));
  expect('la doctora recibe doctor_reminder_undelivered', await waitFor(() => doctorTemplates('doctor_reminder_undelivered').length === beforeUndelivered + 1));
  const undeliveredParams = templateParams(doctorTemplates('doctor_reminder_undelivered').at(-1));
  expect('template con 5 variables: nombre, fecha, hora, consultorio, teléfono',
    undeliveredParams.length === 5 && undeliveredParams[0] === 'Fernanda Fallida' && undeliveredParams[2] === '10:00' && undeliveredParams[4] === `+${PHONE_FAILED}`,
    JSON.stringify(undeliveredParams));

  await postStatus(failedStatus(fail.reminderMessageId, PHONE_FAILED));
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect('status failed repetido (reintento de Meta) no avisa dos veces', doctorTemplates('doctor_reminder_undelivered').length === beforeUndelivered + 1);

  console.log('\n── Template dedicado aún no aprobado → cae a doctor_alert ──');

  unapprovedTemplates.add('doctor_reminder_undelivered');
  const alertsBefore = doctorTemplates('doctor_alert').length;
  await postStatus(failedStatus(unapproved.reminderMessageId, PHONE_UNAPPROVED));
  expect('132001 → aviso por doctor_alert', await waitFor(() => doctorTemplates('doctor_alert').length === alertsBefore + 1));
  const alertParam = templateParams(doctorTemplates('doctor_alert').at(-1))[0] ?? '';
  expect('doctor_alert con la versión de una línea', alertParam.includes('Ursula Sin Template') && alertParam.includes('recordatorio') && !alertParam.includes('\n'), alertParam);
  unapprovedTemplates.clear();

  console.log('\n── El chequeo de no-respuesta ya no incluye los no entregados ──');

  const noResponseBefore = doctorTemplates('doctor_no_response').length;
  // Simula que los recordatorios se mandaron hace 2 horas (ventana del chequeo).
  await pool.query('UPDATE appointments SET reminder_sent_at = NOW() - INTERVAL 2 HOUR WHERE id IN (?)', [[apptRead, apptFailed, apptUnapproved]]);
  await runCheckNoResponses();
  const noResponseNames = doctorTemplates('doctor_no_response').slice(noResponseBefore).map((c) => templateParams(c)[0]);
  expect('"no ha confirmado" para la que sí lo recibió', noResponseNames.includes('Rosa Entregada'), JSON.stringify(noResponseNames));
  expect('sin "no ha confirmado" para las que nunca lo recibieron',
    !noResponseNames.includes('Fernanda Fallida') && !noResponseNames.includes('Ursula Sin Template'), JSON.stringify(noResponseNames));

  console.log('\n── Carrera: el failed llega antes de guardar el wamid ──');

  const apptLate = await createAppointment(PHONE_LATE, 'Lucía Tardía', addDays(new Date(), 3));
  const lateWamid = `wamid.late.${Date.now()}`;
  const lateBefore = doctorTemplates('doctor_reminder_undelivered').length;
  await postStatus(failedStatus(lateWamid, PHONE_LATE));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await appointmentRepository.markReminderSent(apptLate, lateWamid);
  expect('se reintenta la búsqueda y se marca como no entregado', await waitFor(async () => (await appointmentRepository.getById(apptLate)).reminderDeliveryStatus === 'failed', 8000));
  expect('y la doctora recibe el aviso', doctorTemplates('doctor_reminder_undelivered').length === lateBefore + 1);

  console.log('\n── Failed de un aviso a la propia doctora: solo log ──');

  const callsBefore = graphCalls.length;
  await postStatus(failedStatus('wamid.doctor.1', config.DOCTOR_PERSONAL_PHONE.replace('+', ''), 131047));
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect('no intenta avisarle a la doctora de su propio aviso fallido', graphCalls.length === callsBefore);

  // La doctora también puede ser paciente: su recordatorio fallido se registra
  // aunque el destinatario sea su número (hallazgo del E2E local).
  const doctorPhone = config.DOCTOR_PERSONAL_PHONE.replace('+', '');
  await pool.query('INSERT IGNORE INTO patients (phone, name) VALUES (?, ?)', [doctorPhone, 'Doctora Paciente']);
  const apptDoctor = randomUUID();
  await appointmentRepository.create({
    id: apptDoctor,
    patientPhone: doctorPhone,
    patientName: 'Doctora Paciente',
    consultationType: 'subsecuente',
    location: 'norte',
    scheduledAt: addDays(new Date(), 2),
    durationMin: 40,
  });
  const doctorWamid = `wamid.doctor.reminder.${Date.now()}`;
  await appointmentRepository.markReminderSent(apptDoctor, doctorWamid);
  await postStatus(failedStatus(doctorWamid, doctorPhone));
  const doctorMarked = await waitFor(async () => (await appointmentRepository.getById(apptDoctor)).reminderDeliveryStatus === 'failed');
  await pool.query('DELETE FROM appointments WHERE id = ?', [apptDoctor]);
  await pool.query("DELETE FROM patients WHERE phone = ? AND name = 'Doctora Paciente'", [doctorPhone]);
  expect('recordatorio fallido de la doctora como paciente: se registra', doctorMarked);

  console.log('\n── Oferta de lista de espera no entregada → regresa a la doctora ──');

  const apptOffer = await createAppointment(PHONE_OFFER, 'Olga Oferta', addDays(new Date(), 20), 'sur');
  const entryId = randomUUID();
  await waitlistRepository.addEntry({ id: entryId, appointmentId: apptOffer });
  const offerId = randomUUID();
  await waitlistRepository.createOffer({
    id: offerId,
    sourceAppointmentId: null,
    location: 'smoke_delivery',
    scheduledAt: addDays(new Date(), 2),
    durationMin: 40,
  });
  await waitlistRepository.markOfferedToPatient(offerId, entryId);
  const offerWamid = `wamid.offer.${Date.now()}`;
  await waitlistRepository.setOfferMessageId(offerId, offerWamid);

  const alertsBeforeOffer = doctorTemplates('doctor_alert').length;
  await postStatus(failedStatus(offerWamid, PHONE_OFFER));
  expect('la oferta regresa a la doctora (o se cierra si no hay más candidatas)', await waitFor(async () => {
    const offer = await waitlistRepository.getOfferById(offerId);
    return offer.status !== 'offered_patient' && offer.declinedWaitlistIds.includes(entryId);
  }));
  expect('la doctora recibe el aviso de oferta no entregada', await waitFor(() => doctorTemplates('doctor_alert').length > alertsBeforeOffer
    || doctorTemplates('doctor_waitlist_offer').some((c) => templateParams(c)[0]?.includes('No se pudo entregar la oferta'))));
  const offerNotice = [
    ...doctorTemplates('doctor_alert').slice(alertsBeforeOffer).map((c) => templateParams(c)[0]),
    ...doctorTemplates('doctor_waitlist_offer').map((c) => templateParams(c)[0]),
  ].join(' ');
  expect('el aviso nombra a la paciente y dice que no se entregó', offerNotice.includes('Olga Oferta') && offerNotice.includes('No se pudo entregar'), offerNotice);
} catch (err) {
  failed += 1;
  console.error('\n💥 Error inesperado en el smoke test:', err);
} finally {
  await cleanup();
  server.close();
  await closeDb();
}

console.log(`\nResultado: ${passed} pass / ${failed} fail · ${graphCalls.length} llamadas simuladas a la Graph API`);
process.exit(failed === 0 ? 0 : 1);
