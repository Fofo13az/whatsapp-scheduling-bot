import mysql from 'mysql2/promise';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'db' });

export const pool = mysql.createPool({
  host: config.MYSQL_HOST,
  port: config.MYSQL_PORT,
  user: config.MYSQL_USER,
  password: config.MYSQL_PASSWORD,
  database: config.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: config.MYSQL_CONNECTION_LIMIT,
  maxIdle: config.MYSQL_CONNECTION_LIMIT,
  idleTimeout: 60000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  timezone: 'Z',
});

// `timezone: 'Z'` solo controla cómo el CLIENTE serializa/parsea fechas; el
// SERVIDOR evalúa NOW() y CURRENT_TIMESTAMP con su propia time_zone (en dev
// local: hora CDMX). Sin alinear la sesión a UTC, un `updated_at` recién
// escrito se lee como si tuviera 6 horas de antigüedad y el timeout de
// conversación expira todo al instante. Se fija en cada conexión nueva del pool.
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

const REQUIRED_TABLES = ['patients', 'appointments', 'conversations', 'waitlist', 'slot_offers'];

// Columnas agregadas por migraciones sobre tablas ya existentes. Si falta
// alguna, el código nuevo tronaría en runtime con una paciente real: mejor
// fallar al boot con la instrucción exacta.
const REQUIRED_COLUMNS = [
  { table: 'appointments', column: 'reminder_message_id', migration: '2026-09-24_actualizacion.sql' },
  { table: 'appointments', column: 'reminder_delivery_status', migration: '2026-09-24_actualizacion.sql' },
  { table: 'appointments', column: 'reminder_delivery_error', migration: '2026-09-24_actualizacion.sql' },
  { table: 'slot_offers', column: 'offer_message_id', migration: '2026-09-24_actualizacion.sql' },
  { table: 'slot_offers', column: 'doctor_browsed_at', migration: '2026-09-24_actualizacion.sql' },
];

export async function connectDb() {
  try {
    await pool.query('SELECT 1');
    log.info(
      { host: config.MYSQL_HOST, database: config.MYSQL_DATABASE },
      'Conexion a MySQL establecida',
    );
  } catch (err) {
    log.fatal({ err }, 'No se pudo conectar a MySQL');
    throw err;
  }

  // Fail fast si la DB está vacía (ej. servicio MySQL recién creado en
  // Railway): mejor un error claro al boot que 500s crípticos al primer
  // mensaje de una paciente. La inicialización es manual y explícita
  // (node scripts/init-db.js), no auto-migración al arranque.
  const [rows] = await pool.query(
    `SELECT table_name AS tableName FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name IN (?)`,
    [REQUIRED_TABLES],
  );
  const found = new Set(rows.map((r) => r.tableName));
  const missing = REQUIRED_TABLES.filter((t) => !found.has(t));
  if (missing.length > 0) {
    const err = new Error(
      `Faltan tablas en la DB "${config.MYSQL_DATABASE}": ${missing.join(', ')}. ` +
        'Corre "node scripts/init-db.js" para aplicar el schema.',
    );
    log.fatal({ missing }, err.message);
    throw err;
  }

  const [columnRows] = await pool.query(
    `SELECT table_name AS tableName, column_name AS columnName FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name IN (?)`,
    [[...new Set(REQUIRED_COLUMNS.map((c) => c.table))]],
  );
  const foundColumns = new Set(columnRows.map((r) => `${r.tableName}.${r.columnName}`));
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !foundColumns.has(`${c.table}.${c.column}`));
  if (missingColumns.length > 0) {
    const migrations = [...new Set(missingColumns.map((c) => c.migration))];
    const err = new Error(
      `Faltan columnas en la DB "${config.MYSQL_DATABASE}": ` +
        `${missingColumns.map((c) => `${c.table}.${c.column}`).join(', ')}. ` +
        `Aplica la migración: ${migrations.map((m) => `src/db/migrations/${m}`).join(', ')}.`,
    );
    log.fatal({ missing: missingColumns }, err.message);
    throw err;
  }
}

export async function closeDb() {
  await pool.end();
  log.info('Pool de MySQL cerrado');
}