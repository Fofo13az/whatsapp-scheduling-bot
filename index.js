import express from 'express';
import { config } from './src/config/index.js';
import { logger } from './src/lib/logger.js';
import { whatsappWebhookRouter } from './src/webhook/whatsappWebhook.js';
import { connectDb, closeDb } from './src/db/connection.js';
import * as calendarService from './src/services/calendarService.js';
import { startScheduler, stopScheduler } from './src/scheduler/index.js';

const app = express();

app.disable('x-powered-by');

// Meta manda los webhooks como JSON. `verify` guarda el body crudo porque
// la firma X-Hub-Signature-256 se calcula sobre los bytes exactos del body.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    env: config.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

app.use('/webhook/whatsapp', whatsappWebhookRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Error no manejado');
  res.status(500).json({ error: 'Internal server error' });
});

// 1) Conectar DB ANTES de aceptar tráfico. Si falla, salir.
try {
  await connectDb();
} catch (err) {
  logger.fatal({ err }, 'Error al conectar: DB no disponible');
  process.exit(1);
}

// 2) Calendarios (CalDAV/iCloud + Google, según ruteo por consultorio):
//    verificar conexión al boot si hay algo configurado.
//    - Sin configurar → warning y seguimos (agenda solo en MySQL).
//    - Configurado pero falla → en development salimos (fail fast: casi
//      seguro es un typo de credenciales); en production seguimos degradados
//      PARCIALMENTE: los calendarios sanos siguen operando (resiliencia por
//      calendario) y solo lo caído queda fuera — no queremos que un reinicio
//      deje al bot muerto.
if (calendarService.isConfigured()) {
  const calendarStatus = await calendarService.ping();
  if (calendarStatus.ok) {
    logger.info({ calendars: calendarStatus.calendars }, 'Calendarios conectados');
  } else if (config.NODE_ENV === 'production') {
    logger.error(
      { error: calendarStatus.error, calendars: calendarStatus.calendars },
      'Calendario(s) con problemas — arrancando degradado (los sanos siguen operando)',
    );
  } else {
    logger.fatal({ error: calendarStatus.error }, 'Calendario configurado pero la conexión falló — revisa credenciales/calendarios');
    process.exit(1);
  }
} else {
  logger.warn('Calendarios sin configurar — las citas se agendan solo en MySQL, sin evento de calendario');
}

// 3) Scheduler: recordatorios nocturnos, chequeo de no-respuesta y barrido
//    de citas completadas (Fase 3). Requiere DB conectada.
await startScheduler();

// 4) Ya con DB lista, abrir el puerto.
const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, tz: config.TIMEZONE },
    'Server escuchando',
  );
});

const shutdown = (signal) => {
  logger.info({ signal }, 'Apagando server...');
  stopScheduler();
  server.close(async (err) => {
    if (err) {
      logger.error({ err }, 'Error al cerrar el server');
      process.exit(1);
    }
    logger.info('Server cerrado limpiamente');
    try {
      await closeDb();
    } catch (closeErr) {
      logger.error({ err: closeErr }, 'Error al cerrar pool de DB');
    }
    process.exit(0);
  });
  // Si tarda más de 10s, forzar.
  setTimeout(() => {
    logger.warn('Cerrado forzado tras 10s');
    process.exit(1);
  }, 10_000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — saliendo');
  process.exit(1);
});
