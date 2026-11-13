/**
 * calendarService — fachada única de calendario para el resto del bot.
 *
 * Cada consultorio se rutea a su proveedor (calendarRouting): CalDAV/iCloud
 * o Google Calendar. Los flujos y la disponibilidad hablan SOLO con este
 * módulo — el contrato es el mismo que tenía caldavService, así que el resto
 * del código no distingue proveedores.
 *
 * Reglas:
 *   - Escritura (create/delete): al proveedor del consultorio de la cita.
 *     deleteEvent intenta después los demás proveedores configurados — cubre
 *     eventos creados antes de un cambio de ruteo.
 *   - Lectura (listEvents): TODOS los proveedores configurados fusionados
 *     (bloqueo global: la doctora no puede estar en dos consultorios a la
 *     vez). Resiliencia por proveedor: uno caído se loggea y se sigue con el
 *     otro; solo si TODOS fallan se lanza (y availabilityService degrada a
 *     MySQL-only, fail-open).
 *   - ping: agrega el estado de cada proveedor para el boot y los smokes.
 */

import { logger } from '../lib/logger.js';
import * as caldavService from './caldavService.js';
import * as googleCalendarService from './googleCalendarService.js';
import { providerFor } from './calendarRouting.js';

const log = logger.child({ module: 'calendarService' });

const SERVICES = {
  caldav: caldavService,
  google: googleCalendarService,
};

function serviceFor(location) {
  return SERVICES[providerFor(location)];
}

function configuredServices() {
  return Object.values(SERVICES).filter((service) => service.isConfigured());
}

/**
 * ¿Hay al menos un proveedor de calendario configurado? Los callers degradan
 * limpio (agenda solo en MySQL) cuando no.
 *
 * @returns {boolean}
 */
export function isConfigured() {
  return configuredServices().length > 0;
}

/**
 * Eventos de TODOS los proveedores configurados que se traslapan con
 * [from, to].
 *
 * @param {{ from: Date, to: Date }} args
 * @returns {Promise<Array<{ uid: string|null, summary: string|null, location: string|null, start: Date, end: Date, allDay: boolean }>>}
 */
export async function listEvents({ from, to }) {
  const services = configuredServices();
  if (services.length === 0) return [];

  const results = await Promise.allSettled(
    services.map((service) => service.listEvents({ from, to })),
  );

  const events = [];
  const errors = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      events.push(...result.value);
    } else {
      errors.push(result.reason);
      log.error({ err: result.reason }, 'Un proveedor de calendario falló en listEvents — se continúa con los demás');
    }
  }

  // Todos caídos → que el caller aplique su política (fail-open en
  // availabilityService, con log de que los bloqueos se ignoraron).
  if (events.length === 0 && errors.length === services.length && errors.length > 0) {
    throw errors[0];
  }
  return events;
}

/**
 * Crea el evento en el proveedor del consultorio indicado.
 *
 * @param {{ summary: string, start: Date, end: Date, location: string, description?: string }} args
 * @returns {Promise<{ uid: string }>}
 */
export async function createEvent(args) {
  const service = serviceFor(args.location);
  if (!service.isConfigured()) {
    throw new Error(
      `calendarService: el proveedor "${providerFor(args.location)}" del consultorio "${args.location}" no está configurado`,
    );
  }
  return service.createEvent(args);
}

/**
 * Borra un evento: primero en el proveedor del consultorio, luego en el
 * resto de los configurados (eventos creados con un ruteo anterior).
 *
 * @param {{ uid: string, location?: string }} args
 * @returns {Promise<{ ok: boolean }>}
 */
export async function deleteEvent({ uid, location }) {
  const preferred = location ? serviceFor(location) : null;
  const ordered = [
    ...(preferred?.isConfigured() ? [preferred] : []),
    ...configuredServices().filter((s) => s !== preferred),
  ];

  let lastError = null;
  for (const service of ordered) {
    try {
      const result = await service.deleteEvent({ uid, location });
      if (result.ok) return result;
    } catch (err) {
      lastError = err;
      log.error({ err, uid }, 'deleteEvent falló en un proveedor — intentando el siguiente');
    }
  }

  if (lastError) throw lastError;
  return { ok: false };
}

/**
 * Busca el evento de una cita en todos los proveedores (primero el del
 * consultorio). Usado por calendarSync para detectar cambios manuales.
 *
 * Contrato de seguridad: "missing" SOLO si todos los proveedores respondieron
 * que no existe. Si el proveedor del consultorio no está configurado o alguno
 * falló sin que otro lo encontrara, lanza — el caller lo trata como "no
 * verificable" y no toca la cita.
 *
 * @param {{ uid: string, location: string }} args
 * @returns {Promise<{ status: 'found', start: Date, end: Date, allDay: boolean } | { status: 'missing' }>}
 */
export async function getEvent({ uid, location }) {
  const preferred = serviceFor(location);
  if (!preferred?.isConfigured()) {
    throw new Error(
      `calendarService.getEvent: el proveedor "${providerFor(location)}" del consultorio "${location}" no está configurado`,
    );
  }
  const ordered = [preferred, ...configuredServices().filter((s) => s !== preferred)];

  let lastError = null;
  for (const service of ordered) {
    try {
      const result = await service.getEvent({ uid, location });
      if (result.status === 'found') return result;
    } catch (err) {
      lastError = err;
      log.warn({ err, uid }, 'getEvent falló en un proveedor — intentando el siguiente');
    }
  }

  if (lastError) throw lastError;
  return { status: 'missing' };
}

/**
 * Estado agregado de todos los proveedores configurados, para el health
 * check de arranque y los smokes.
 *
 * @returns {Promise<{ ok: boolean, calendars: Record<string, string>, error?: string }>}
 */
export async function ping() {
  const entries = Object.entries(SERVICES).filter(([, service]) => service.isConfigured());
  const calendars = {};
  const errors = [];

  for (const [name, service] of entries) {
    const status = await service.ping();
    Object.assign(calendars, status.calendars ?? {});
    if (!status.ok) errors.push(`[${name}] ${status.error}`);
  }

  return errors.length > 0
    ? { ok: false, calendars, error: errors.join(' · ') }
    : { ok: true, calendars };
}
