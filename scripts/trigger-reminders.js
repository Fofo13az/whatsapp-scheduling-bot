/**
 * Dispara manualmente los jobs del scheduler SIN esperar al cron.
 * ⚠️ Manda mensajes REALES por la Cloud API (a diferencia de los smoke tests).
 *
 * Uso:
 *   node scripts/trigger-reminders.js                → job de recordatorios
 *                                                      (incluye el sync previo con el calendario)
 *   node scripts/trigger-reminders.js --no-response  → chequeo de no-respuesta
 *   node scripts/trigger-reminders.js --calendar-sync → barrido de citas vs. calendario
 *                                                      (el job diario de las 07:00)
 *
 * Útil para la prueba E2E de Fase 3: agenda una cita para mañana desde
 * WhatsApp, corre esto, y el recordatorio con botones llega a tu teléfono.
 */

import 'dotenv/config';

const { connectDb, closeDb } = await import('../src/db/connection.js');
const { runSendReminders } = await import('../src/scheduler/jobs/sendReminders.js');
const { runCheckNoResponses } = await import('../src/scheduler/jobs/checkNoResponses.js');
const { runCalendarSync } = await import('../src/services/calendarSync.js');

await connectDb();

try {
  if (process.argv.includes('--calendar-sync')) {
    const { total, blocked, results } = await runCalendarSync({ context: 'manual' });
    const count = (status) => results.filter((r) => r.status === status && (status === 'ok' || status === 'unverifiable' || r.applied)).length;
    console.log(
      `
Sync con calendario: ${total} cita(s) revisadas — ${count('ok')} sin cambios, ` +
      `${count('moved')} movidas, ${count('deleted')} borradas, ${count('unverifiable')} no verificables` +
      (blocked ? ' — ⚠️ FRENO DE SEGURIDAD: no se aplicó nada' : '.'),
    );
  } else if (process.argv.includes('--no-response')) {
    const result = await runCheckNoResponses();
    console.log(`\nChequeo de no-respuesta: ${result.unconfirmed} paciente(s) sin responder.`);
  } else {
    const result = await runSendReminders();
    console.log(`\nRecordatorios: ${result.sent} enviados, ${result.failed} fallidos de ${result.total}.`);
  }
} finally {
  await closeDb();
}
