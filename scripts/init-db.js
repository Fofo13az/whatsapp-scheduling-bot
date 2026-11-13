/**
 * init-db — aplica src/db/schema.sql contra la DB configurada en el .env
 * (o en las env vars del proceso, que tienen prioridad sobre el .env).
 *
 * Pensado para inicializar la MySQL de Railway sin cliente mysql a la mano:
 *
 *   node scripts/init-db.js
 *
 * Idempotente: el schema usa CREATE TABLE IF NOT EXISTS, así que correrlo
 * sobre una DB ya inicializada no hace nada. Se saltan los statements
 * CREATE DATABASE / USE porque la conexión ya llega con la DB seleccionada
 * (en Railway el usuario ni siquiera tiene permiso de crear otras bases).
 *
 * Para apuntar a Railway desde local sin tocar el .env (PowerShell):
 *   $env:MYSQL_HOST='...'; $env:MYSQL_PORT='...'; $env:MYSQL_USER='...';
 *   $env:MYSQL_PASSWORD='...'; $env:MYSQL_DATABASE='railway'; node scripts/init-db.js
 *
 * Migraciones (DBs creadas antes de un cambio de schema): en lugar del schema
 * completo se aplica el archivo indicado. NO son idempotentes (ALTER TABLE):
 * correr cada una una sola vez por DB.
 *   node scripts/init-db.js --migration src/db/migrations/2026-09-24_actualizacion.sql
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool, closeDb } from '../src/db/connection.js';
import { logger } from '../src/lib/logger.js';

const log = logger.child({ module: 'init-db' });

const migrationFlag = process.argv.indexOf('--migration');
const migrationPath = migrationFlag === -1 ? null : process.argv[migrationFlag + 1];
if (migrationFlag !== -1 && !migrationPath) {
  log.error('Falta la ruta: node scripts/init-db.js --migration <archivo.sql>');
  process.exit(1);
}

const schemaPath = migrationPath
  ?? fileURLToPath(new URL('../src/db/schema.sql', import.meta.url));
const schemaSql = await readFile(schemaPath, 'utf8');

// Primero fuera los comentarios (línea completa o al final de línea) — pueden
// contener ";" y romperían el split. El schema no usa strings con "--" ni ";",
// así que el recorte simple es correcto aquí.
const withoutComments = schemaSql
  .split('\n')
  .map((line) => {
    const commentStart = line.indexOf('--');
    return commentStart === -1 ? line : line.slice(0, commentStart);
  })
  .join('\n');

// Statements separados por ";". Sin triggers ni procedures, no hay ";" embebidos.
const statements = withoutComments
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  // La conexión ya trae la DB seleccionada (MYSQL_DATABASE); crear/seleccionar
  // base solo aplica al uso manual local con el cliente mysql.
  .filter((s) => !/^CREATE DATABASE\b/i.test(s) && !/^USE\b/i.test(s));

try {
  for (const statement of statements) {
    await pool.query(statement);
    const summary = statement.split('\n')[0].slice(0, 80);
    log.info({ statement: summary }, 'Statement ejecutado');
  }

  if (migrationPath) {
    log.info({ migration: migrationPath }, 'Migración aplicada');
  } else {
    await verifyTables();
  }
} catch (err) {
  log.error({ err }, migrationPath ? 'Fallo aplicando la migración' : 'Fallo aplicando el schema');
  process.exitCode = 1;
} finally {
  await closeDb();
}

async function verifyTables() {
  const [rows] = await pool.query(
    `SELECT table_name AS tableName FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name IN ('patients', 'appointments', 'conversations', 'waitlist', 'slot_offers')`,
  );
  const found = rows.map((r) => r.tableName).sort();
  if (found.length === 5) {
    log.info({ tables: found }, 'Schema aplicado — las 5 tablas existen');
  } else {
    log.error({ tables: found }, 'Schema incompleto tras aplicar — revisa errores arriba');
    process.exitCode = 1;
  }
}
