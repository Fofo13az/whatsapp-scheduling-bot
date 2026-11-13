/**
 * Smoke test de googleCalendarService + calendarService (fachada) + ruteo.
 *
 * Sin red: la API de Google se stubbea con un fetch falso que además VERIFICA
 * la firma RS256 del JWT de la service account contra una llave generada
 * al vuelo. Cubre: token (firma + caching), listEvents (mapeo de eventos con
 * hora, all-day, cancelados y transparentes; paginación), createEvent,
 * deleteEvent (404/410), ping, y el ruteo por consultorio de la fachada.
 *
 * Uso: node scripts/smoke-google-calendar.js
 */

import crypto from 'node:crypto';
import 'dotenv/config';

// ── Config del escenario: sur→Google, norte→CalDAV sin configurar ───
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_EMAIL = 'scheduler-bot@smoke-test.iam.gserviceaccount.com';
const CALENDAR_ID = 'doctora.smoke@gmail.com';

process.env.GOOGLE_SA_EMAIL = SA_EMAIL;
process.env.GOOGLE_SA_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.GOOGLE_CALENDAR_SUR = CALENDAR_ID;
delete process.env.GOOGLE_CALENDAR_NORTE;
delete process.env.CALDAV_USERNAME;
delete process.env.CALDAV_APP_SPECIFIC_PASSWORD;
delete process.env.CALDAV_CALENDAR_NAME;
delete process.env.CALDAV_CALENDAR_SUR;
delete process.env.CALDAV_CALENDAR_NORTE;

// ── Stub de la API de Google ────────────────────────────────────────────────
let tokenRequests = 0;
let lastEventsQuery = null;
let lastInsertBody = null;
const deleteResponses = []; // cola de status codes para DELETE

globalThis.fetch = async (url, options = {}) => {
  const u = new URL(String(url));
  const method = options.method ?? 'GET';

  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  if (u.origin === 'https://oauth2.googleapis.com' && u.pathname === '/token') {
    tokenRequests += 1;
    const params = new URLSearchParams(options.body);
    const assertion = params.get('assertion');
    const [h, c, s] = assertion.split('.');
    const validSig = crypto
      .createVerify('RSA-SHA256')
      .update(`${h}.${c}`)
      .verify(publicKey, Buffer.from(s, 'base64url'));
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    if (!validSig || claims.iss !== SA_EMAIL || claims.aud !== 'https://oauth2.googleapis.com/token') {
      return json(401, { error: 'invalid_grant', error_description: 'JWT inválido en el stub' });
    }
    return json(200, { access_token: 'stub-token', expires_in: 3600, token_type: 'Bearer' });
  }

  if (u.origin !== 'https://www.googleapis.com' || (options.headers?.Authorization !== 'Bearer stub-token')) {
    throw new Error(`fetch inesperado en smoke test: ${method} ${url}`);
  }

  const eventsPath = `/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;

  if (method === 'GET' && u.pathname === eventsPath) {
    lastEventsQuery = Object.fromEntries(u.searchParams);
    if (!u.searchParams.get('pageToken')) {
      return json(200, {
        nextPageToken: 'page2',
        items: [
          {
            id: 'ev-timed',
            summary: 'Paciente agendada a mano',
            status: 'confirmed',
            start: { dateTime: '2026-08-24T15:00:00-06:00' },
            end: { dateTime: '2026-08-24T15:40:00-06:00' },
          },
          {
            id: 'ev-cancelled',
            status: 'cancelled',
            start: { dateTime: '2026-08-24T16:00:00-06:00' },
            end: { dateTime: '2026-08-24T16:40:00-06:00' },
          },
          {
            id: 'ev-transparent',
            summary: 'Recordatorio (disponible)',
            transparency: 'transparent',
            start: { dateTime: '2026-08-24T17:00:00-06:00' },
            end: { dateTime: '2026-08-24T17:40:00-06:00' },
          },
        ],
      });
    }
    return json(200, {
      items: [
        {
          id: 'ev-allday',
          summary: 'Congreso',
          start: { date: '2026-08-25' },
          end: { date: '2026-08-26' },
        },
      ],
    });
  }

  if (method === 'POST' && u.pathname === eventsPath) {
    lastInsertBody = JSON.parse(options.body);
    return json(200, { id: 'ev-created-123', ...lastInsertBody });
  }

  if (method === 'DELETE' && u.pathname.startsWith(`${eventsPath}/`)) {
    const status = deleteResponses.shift() ?? 204;
    return status === 204 ? json(204, null) : json(status, { error: { message: `HTTP ${status}` } });
  }

  if (method === 'GET' && u.pathname === `/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}`) {
    return json(200, { id: CALENDAR_ID, summary: 'Calendario sur' });
  }

  throw new Error(`ruta no stubbeada: ${method} ${url}`);
};

// ── Imports (después de fijar env y stub) ───────────────────────────────────
const routing = await import('../src/services/calendarRouting.js');
const googleService = await import('../src/services/googleCalendarService.js');
const caldavService = await import('../src/services/caldavService.js');
const calendarService = await import('../src/services/calendarService.js');

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

try {
  console.log('\n── Ruteo por consultorio ──');
  expect('sur → google', routing.providerFor('sur') === 'google');
  expect('norte → caldav', routing.providerFor('norte') === 'caldav');
  expect('googleCalendarService configurado', googleService.isConfigured());
  expect('caldavService NO configurado (sin creds)', !caldavService.isConfigured());
  expect('fachada configurada con un solo proveedor', calendarService.isConfigured());

  console.log('\n── listEvents (mapeo + paginación + filtros) ──');
  const from = new Date('2026-08-24T00:00:00Z');
  const to = new Date('2026-08-27T00:00:00Z');
  const events = await calendarService.listEvents({ from, to });

  expect('token pedido una sola vez (cacheado)', tokenRequests === 1, `tokenRequests=${tokenRequests}`);
  expect('singleEvents y timeMin/timeMax en la query',
    lastEventsQuery?.singleEvents === 'true' && Boolean(lastEventsQuery?.timeMin) && Boolean(lastEventsQuery?.timeMax));
  expect('2 eventos bloquean (cancelado y transparente fuera)', events.length === 2, JSON.stringify(events));

  const timed = events.find((e) => e.uid === 'ev-timed');
  expect('evento con hora mapeado a UTC', timed?.start?.toISOString() === '2026-08-24T21:00:00.000Z' && !timed.allDay);

  const allday = events.find((e) => e.uid === 'ev-allday');
  expect('all-day bloquea el día en hora del consultorio (paginado)',
    allday?.allDay === true
    && allday.start.toISOString() === '2026-08-25T06:00:00.000Z'
    && allday.end.toISOString() === '2026-08-26T06:00:00.000Z',
    JSON.stringify(allday));

  console.log('\n── createEvent (vía fachada) ──');
  const created = await calendarService.createEvent({
    summary: 'Cita: María Prueba (Consulta subsecuente)',
    start: new Date('2026-08-24T14:00:00Z'),
    end: new Date('2026-08-24T14:40:00Z'),
    description: 'nota',
    location: 'sur',
  });
  expect('devuelve el id del evento de Google', created.uid === 'ev-created-123');
  expect('payload con dateTime UTC', lastInsertBody?.start?.dateTime === '2026-08-24T14:00:00.000Z'
    && lastInsertBody?.summary?.includes('María'));

  let norteError = null;
  try {
    await calendarService.createEvent({
      summary: 'x', start: new Date(), end: new Date(), location: 'norte',
    });
  } catch (err) {
    norteError = err;
  }
  expect('createEvent a norte falla claro (caldav sin configurar)',
    norteError?.message?.includes('no está configurado'), norteError?.message);

  console.log('\n── deleteEvent ──');
  deleteResponses.push(204);
  expect('borrado normal ok', (await calendarService.deleteEvent({ uid: 'ev-1', location: 'sur' })).ok === true);
  deleteResponses.push(410);
  expect('410 (ya borrado) cuenta como ok', (await calendarService.deleteEvent({ uid: 'ev-1', location: 'sur' })).ok === true);
  deleteResponses.push(404);
  expect('404 en todos los calendarios → ok:false', (await calendarService.deleteEvent({ uid: 'ev-nope', location: 'sur' })).ok === false);

  console.log('\n── ping ──');
  const status = await calendarService.ping();
  expect('ping ok con el nombre del calendario', status.ok === true && status.calendars?.sur === 'Calendario sur', JSON.stringify(status));
} catch (err) {
  failed += 1;
  console.error('\n💥 Error inesperado en el smoke test:', err);
}

console.log(`\nResultado: ${passed} pass / ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
