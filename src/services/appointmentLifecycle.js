/**
 * appointmentLifecycle — operaciones compartidas sobre citas que tocan más de
 * una fuente (MySQL + CalDAV + notificaciones).
 *
 * La cancelación se dispara desde dos lugares (respuesta al recordatorio y
 * cancellationFlow) y el reagendamiento también borra eventos; centralizar
 * aquí evita duplicar la política de resiliencia:
 *
 *   MySQL es la fuente de verdad — se actualiza primero y sin red de
 *   seguridad (si truena, el caller debe enterarse). El calendario es
 *   secundario: si CalDAV falla, se loggea y la operación se da por buena
 *   (el evento huérfano se reconcilia a mano o con la reconciliación
 *   automática pendiente — TODO Fase 4).
 */

import { logger } from '../lib/logger.js';
import * as appointmentRepository from './appointmentRepository.js';
import * as calendarService from './calendarService.js';
import * as notificationService from './notificationService.js';
// Import circular con waitlistService (que usa removeCalendarEvent):
// inofensivo — ambos lados solo usan funciones en runtime, nunca al cargar.
import * as waitlistService from './waitlistService.js';

const log = logger.child({ module: 'appointmentLifecycle' });

/**
 * Cancela una cita por completo: status en MySQL, evento de calendario y
 * (opcional) notificación a la doctora.
 *
 * @param {object} appointment  Forma de appointmentRepository (camelCase)
 * @param {{ notifyDoctor?: boolean }} [options]  notifyDoctor=false cuando el
 *   caller manda una notificación distinta (ej. reagendamiento)
 */
export async function cancelAppointment(appointment, { notifyDoctor = true } = {}) {
  await appointmentRepository.markCancelled(appointment.id);
  await removeCalendarEvent(appointment);
  if (notifyDoctor) {
    await notificationService.notifyCancellation(appointment);
  }
  log.info(
    { appointmentId: appointment.id, patientPhone: appointment.patientPhone },
    'Cita cancelada',
  );

  // Lista de espera: si el hueco liberado le sirve a alguien, ofrecérselo a
  // la doctora. Nunca lanza — la cancelación ya quedó completa.
  await waitlistService.onSlotFreed(appointment);
}

/**
 * Borra el evento de calendario de una cita, si lo tiene. Nunca lanza:
 * el calendario es secundario a la DB (ver header).
 *
 * @param {object} appointment
 */
export async function removeCalendarEvent(appointment) {
  if (!appointment.caldavEventUid || !calendarService.isConfigured()) return;

  try {
    await calendarService.deleteEvent({
      uid: appointment.caldavEventUid,
      location: appointment.location,
    });
  } catch (err) {
    log.error(
      { err, appointmentId: appointment.id, uid: appointment.caldavEventUid },
      'No se pudo borrar el evento de calendario — la cita ya quedó cancelada en DB',
    );
  }
}
