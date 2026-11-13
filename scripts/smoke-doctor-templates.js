/**
 * Smoke test de la estrategia de templates doctor_* en notificationService.
 *
 * Estrategia (Sesión 10): con DOCTOR_TEMPLATES_ENABLED las notificaciones a
 * la doctora salen DIRECTO por template (Meta puede aceptar un mensaje de
 * sesión y rechazarlo async por ventana cerrada — el template lo evita);
 * el mensaje de sesión queda solo como último recurso si el template falla.
 *
 * La config se congela al importar, así que el toggle se fija ANTES del
 * import y el script corre dos veces:
 *
 *   node scripts/smoke-doctor-templates.js            # DOCTOR_TEMPLATES_ENABLED=true
 *   $env:DOCTOR_TEMPLATES_ENABLED='false'; node scripts/smoke-doctor-templates.js
 *
 * Graph API stubbeada; la respuesta se controla por tipo de mensaje.
 */

process.env.DOCTOR_TEMPLATES_ENABLED ??= 'true';
const TEMPLATES_ENABLED = process.env.DOCTOR_TEMPLATES_ENABLED === 'true';

// ── Stub de la Graph API ─────────────────────────────────────────────────────
const calls = [];
let sessionResponse = { ok: true }; // respuesta a mensajes de sesión (type text)
let templateResponse = { ok: true }; // respuesta a envíos de template
const unapprovedTemplates = new Set(); // templates que responden 132001 (no existen en la WABA)

globalThis.fetch = async (url, options) => {
  if (!String(url).includes('graph.facebook.com')) {
    throw new Error(`fetch inesperado en smoke test: ${url}`);
  }
  const body = JSON.parse(options.body);
  calls.push(body);

  const scenario = body.type === 'template'
    ? (unapprovedTemplates.has(body.template.name) ? { ok: false, code: 132001 } : templateResponse)
    : sessionResponse;
  if (!scenario.ok) {
    return {
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'stub', code: scenario.code, fbtrace_id: 'X' } }),
    };
  }
  return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.stub' }] }) };
};

const notificationService = await import('../src/services/notificationService.js');
const { closeDb } = await import('../src/db/connection.js');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}`);
  }
}

const appointment = {
  id: '00000000-0000-4000-8000-000000000001',
  patientPhone: '5215599990001',
  patientName: 'Paciente Smoke',
  consultationType: 'primera_vez',
  location: 'sur',
  scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  durationMin: 40,
  patientNotes: 'linea 1\nlinea 2\t\ttabs   y    espacios',
};

console.log(`\nSmoke doctor-templates (DOCTOR_TEMPLATES_ENABLED=${TEMPLATES_ENABLED})\n`);

if (TEMPLATES_ENABLED) {
  // Caso 1: template directo — NUNCA intenta sesión primero
  calls.length = 0;
  sessionResponse = { ok: true };
  templateResponse = { ok: true };
  await notificationService.notifyCancellation(appointment);
  check('template directo: exactamente 1 llamada', calls.length === 1);
  check('template directo: fue template, no mensaje de sesión', calls[0]?.type === 'template');
  check('template directo: template correcto', calls[0]?.template?.name === 'doctor_cancellation');
  const cancelParams = calls[0]?.template?.components?.[0]?.parameters?.map((p) => p.text) ?? [];
  check('template directo: 4 params de cuerpo', cancelParams.length === 4);
  check('template directo: param 1 = nombre', cancelParams[0] === 'Paciente Smoke');

  // Caso 2: el template falla (ej. nombre mal escrito en WhatsApp Manager)
  // → cae a mensaje de sesión como último recurso
  calls.length = 0;
  templateResponse = { ok: false, code: 132001 }; // template does not exist
  await notificationService.notifyCancellation(appointment);
  check('template falla: cae a mensaje de sesión', calls.length === 2 && calls[1].type === 'text');

  // Caso 3: system error → template doctor_alert con 1 param de una línea
  calls.length = 0;
  templateResponse = { ok: true };
  await notificationService.notifySystemError(`contexto smoke ${Date.now()}`); // contexto único (throttle de 10 min)
  check('system error: template doctor_alert directo', calls[0]?.template?.name === 'doctor_alert');
  const alertParams = calls[0]?.template?.components?.[0]?.parameters ?? [];
  check('system error: 1 param', alertParams.length === 1);
  check('system error: param sin saltos de línea', !/[\n\t]/.test(alertParams[0]?.text ?? '\n'));

  // Caso 4 (usa DB): cita nueva → doctor_new_appointment, 8 params saneados
  // a una línea (las notas traen \n y \t)
  calls.length = 0;
  await notificationService.notifyNewAppointment(appointment);
  check('cita nueva: template doctor_new_appointment directo', calls[0]?.template?.name === 'doctor_new_appointment');
  const params = calls[0]?.template?.components?.[0]?.parameters?.map((p) => p.text) ?? [];
  check('cita nueva: 8 params', params.length === 8);
  check('cita nueva: notas en una sola línea', params[7] === 'linea 1 linea 2 tabs y espacios');
  check('cita nueva: ningún param vacío o multilínea', params.every((p) => p.length > 0 && !/[\n\t]|\s{4,}/.test(p)));

  // Caso 5 (actualización 23/09): template dedicado aprobado → 1 sola llamada
  calls.length = 0;
  templateResponse = { ok: true };
  await notificationService.notifyReminderUndelivered(appointment);
  check('no entregado: template doctor_reminder_undelivered directo', calls.length === 1 && calls[0]?.template?.name === 'doctor_reminder_undelivered');
  check('no entregado: 5 params', (calls[0]?.template?.components?.[0]?.parameters ?? []).length === 5);

  // Caso 6: template dedicado aún NO aprobado (132001) → cae a doctor_alert
  calls.length = 0;
  unapprovedTemplates.add('doctor_reminder_undelivered');
  await notificationService.notifyReminderUndelivered(appointment);
  check('dedicado sin aprobar: segundo intento con doctor_alert', calls.length === 2 && calls[1]?.template?.name === 'doctor_alert');
  const oneLine = calls[1]?.template?.components?.[0]?.parameters?.[0]?.text ?? '';
  check('dedicado sin aprobar: doctor_alert con la versión de una línea', oneLine.includes('Paciente Smoke') && !/[\n\t]/.test(oneLine));

  // Caso 7: tampoco doctor_alert → último recurso: mensaje de sesión
  calls.length = 0;
  unapprovedTemplates.add('doctor_calendar_removed');
  unapprovedTemplates.add('doctor_alert');
  await notificationService.notifyCalendarRemoved(appointment);
  check('ambos templates fallan: dedicado → doctor_alert → sesión',
    calls.length === 3 && calls[0]?.template?.name === 'doctor_calendar_removed'
      && calls[1]?.template?.name === 'doctor_alert' && calls[2]?.type === 'text');
  unapprovedTemplates.clear();
} else {
  // Caso 1: toggle apagado, sesión OK → un solo envío, sin template
  calls.length = 0;
  sessionResponse = { ok: true };
  await notificationService.notifyCancellation(appointment);
  check('toggle apagado, sesión OK: exactamente 1 llamada', calls.length === 1);
  check('toggle apagado, sesión OK: fue mensaje de texto', calls[0]?.type === 'text');

  // Caso 2: sesión rebota con 131047 → solo warning, sin template
  calls.length = 0;
  sessionResponse = { ok: false, code: 131047 };
  await notificationService.notifyCancellation(appointment);
  check('toggle apagado, 131047: NO intenta template', calls.length === 1);

  // Caso 3: sesión falla con otro código (190 token) → error, sin template
  calls.length = 0;
  sessionResponse = { ok: false, code: 190 };
  await notificationService.notifyCancellation(appointment);
  check('toggle apagado, error 190: NO intenta template', calls.length === 1);
}

await closeDb().catch(() => {});

console.log(`\nResultado: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
