/**
 * Mensajes al usuario en español mexicano.
 *
 * Estos textos son PLACEHOLDERS de desarrollo: tono profesional, cálido y claro,
 * con uso moderado de emojis. La doctora redactará las versiones finales antes de
 * salir a producción (Fase 4).
 *
 * Convenciones:
 *   - Strings simples cuando no hay variables.
 *   - Funciones cuando el texto necesita interpolación.
 *   - Mantenerlos cortos: WhatsApp se siente mejor con burbujas concisas.
 */

import { config } from '../config/index.js';

// Bloque de datos de una paciente de la lista de espera (lo comparten el
// detalle desde un hueco liberado y el de la lista completa).
function waitlistPatientInfo({ name, phone, appointmentLabel, locationLabel, typeLabel, notes, joinedLabel }) {
  return `👤 *${name}*\n` +
    `📞 +${phone}\n` +
    `📅 Su cita actual: ${appointmentLabel}\n` +
    `📍 ${locationLabel}\n` +
    `🏥 ${typeLabel}\n` +
    `💬 Notas: ${notes ?? 'Sin notas'}\n` +
    `🕒 En lista de espera desde: ${joinedLabel}`;
}

export const messages = {
  // ── Bienvenida y comandos generales ─────────────────────────────────────
  greeting: () => //checado
    `👋 ¡Hola! Soy la asistente virtual de la ${config.DOCTOR_NAME}.\n\n` +
    `Puedo ayudarte a *agendar*, *confirmar*, *cancelar* o *cambiar* una cita. ¿Qué te gustaría hacer?`,

  help: //checado
    `ℹ️ *¿Cómo funciono?*\n\n` +
    `• Escribe *agendar* para sacar una cita nueva.\n` +
    `• Escribe *cancelar* para cancelar tu cita.\n` +
    `• Escribe *reagendar* para cambiar tu cita.\n\n` +
    `En cualquier momento puedes responder *atrás* para regresar un paso o *cancelar* para empezar de cero.`,

  unknown:
    `Disculpa, no entendí 🤔\n` +
    `Escribe *agendar* para sacar una cita o *ayuda* si necesitas más información.`,

  cancelled:
    `Listo, cancelé el proceso. Cuando quieras retomarlo, solo escríbeme. 🙌`,

  goodbye: `¡Hasta pronto! Que tengas excelente día. 💛`,

  timeout:
    `Pasó un rato sin actividad, así que reinicié la conversación.\n` +
    `Cuando quieras retomarla, escríbeme *agendar*. 🙌`,

  unsupportedType:
    `Por ahora solo puedo leer mensajes de texto 🙏.\n` +
    `Escribe *agendar* para sacar una cita o *ayuda* para más información.`,

  error:
    `Tuvimos un problema técnico de mi lado 😕. Inténtalo de nuevo en un momento.\n` +
    `Si sigue fallando, la doctora ya fue notificada y te contactará.`,

  // ── Flujo de agendado ───────────────────────────────────────────────────
  appointment: {
    selectType: `¿Qué tipo de consulta necesitas? Elige una opción 👇`, //checado
    selectTypeFallback:
      `Por favor elige una de las opciones que te muestro, o escribe el número correspondiente.`,

    selectLocation: `¡Perfecto! ¿En qué consultorio prefieres tu cita?`,

    invalidOption:
      `No reconocí esa opción 🤔. Elige una de las que te muestro, o escribe el número correspondiente.`,

    // Indicaciones de llegada de un consultorio (firstVisitInfo de
    // availability.json), enviadas la primera vez que la paciente agenda ahí.
    locationInfo: ({ info }) =>
      `📌 *Información importante de la doctora:*\n\n${info}\n\n` +
      `Cuando estés lista, toca *Continuar* para seguir con tu cita. 👇`,
    locationInfoContinue:
      `Para seguir con tu cita, toca el botón *Continuar* o escribe *continuar*. 🙌`,

    selectDate: `Estas son las fechas más cercanas con espacio disponible. ¿Cuál te acomoda?`,
    // TODO Fase 3: ofrecer escalación automática a la doctora en lugar de mandar a la paciente.
    noDatesAvailable: ({ days }) =>
      `Por ahora no veo disponibilidad en los próximos ${days} días para esa combinación 😔. ` +
      `Puedes intentar con el otro consultorio escribiendo *agendar* de nuevo, ` +
      `o escríbele directo a la doctora para encontrar un espacio.`,

    selectTime: ({ dateLabel }) =>
      `Estos son los horarios disponibles para *${dateLabel}*. Toca el que prefieras 👇`,
    // Pista de paginación cuando el día tiene más de 10 horarios (límite de
    // items de WhatsApp): se muestran 9 + la opción "Ver más horarios".
    slotsPageHint: ({ page, pageCount }) =>
      `_Página ${page} de ${pageCount} — toca *Ver más horarios* para ver el resto._`,
    noTimesAvailable:
      `Se acaban de llenar los horarios de ese día. ¿Quieres ver otra fecha?`,

    collectName:
      `¿Me compartes tu *nombre completo*, por favor? Lo necesito para registrar tu cita.`,
    nameInvalid:
      `Necesito un nombre válido para registrarte. ¿Me lo escribes de nuevo, por favor?`,

    collectNotes:
      `¿Hay *algo importante* que quieras que la doctora sepa antes de tu consulta? ` +
      `(síntomas, dudas, antecedentes…)\n\n` +
      `Si no, responde *no* y seguimos. 🙌`,

    confirm: ({ typeLabel, locationLabel, dateLabel, timeLabel, name, notes }) =>
      `Revisa que todo esté correcto antes de confirmar:\n\n` +
      `👤 *${name}*\n` +
      `🏥 ${typeLabel}\n` +
      `📍 ${locationLabel}\n` +
      `📅 ${dateLabel}\n` +
      `🕐 ${timeLabel}\n` +
      (notes ? `\n💬 _${notes}_\n` : ``) +
      `\n¿Confirmamos?`,

    confirmFallback:
      `Solo necesito que confirmes con los botones, o escribe *sí* para confirmar, *no* para cancelar o *de nuevo* para empezar otra vez.`,

    created: ({ dateLabel, timeLabel, locationLabel }) =>
      `¡Listo! Tu cita quedó registrada ✅\n\n` +
      `📅 ${dateLabel}\n` +
      `🕐 ${timeLabel}\n` +
      `📍 ${locationLabel}\n\n` +
      `Te enviaré un recordatorio la noche anterior. Si necesitas reagendar o cancelar, ` +
      `solo escríbeme por aquí. 💛`,

    slotTaken:
      `Justo alguien más acaba de tomar ese horario 🙏. ¿Quieres ver las opciones que siguen?`,
  },

  // ── Cancelación ─────────────────────────────────────────────────────────
  cancellation: {
    noAppointmentsFound:
      `No encuentro citas activas registradas a tu nombre. Si crees que es un error, escríbele directo a la doctora.`,
    selectAppointment:
      `Tienes más de una cita activa. ¿Cuál quieres cancelar? 👇`,
    confirmCancel: ({ dateLabel, timeLabel, locationLabel }) =>
      `Quieres cancelar esta cita, ¿verdad?\n\n` +
      `📅 ${dateLabel}\n` +
      `🕐 ${timeLabel}\n` +
      `📍 ${locationLabel}\n\n` +
      `Confirma para que la libere.`,
    cancelled:
      `Listo, cancelé tu cita y liberé el horario. Cuando quieras volver a agendar, aquí estoy. 🙌`,
    kept:
      `Perfecto, tu cita sigue en pie tal como estaba. Te esperamos. 💛`,
  },

  // ── Reagendamiento ──────────────────────────────────────────────────────
  reschedule: {
    noAppointmentsFound:
      `No encuentro citas activas para reagendar a tu nombre. Si quieres sacar una nueva, escribe *agendar*.`,
    selectAppointment:
      `Tienes más de una cita activa. ¿Cuál quieres reagendar? 👇`,
    intro: ({ dateLabel, timeLabel }) =>
      `Tu cita actual es el *${dateLabel}* a las *${timeLabel}*.\n` +
      `Te muestro otras fechas disponibles para que elijas la que mejor te quede 👇`,
    confirmChange: ({ oldLabel, newLabel }) =>
      `Voy a mover tu cita:\n\n` +
      `❌ Antes: ${oldLabel}\n` +
      `✅ Ahora: ${newLabel}\n\n` +
      `¿Confirmamos el cambio?`,
    success: ({ newLabel }) =>
      `¡Listo! Tu cita quedó reagendada para *${newLabel}* ✅\n` +
      `Te enviaré el recordatorio la noche anterior.`,
    escalate:
      `No encontré espacios convenientes para reagendar de manera automática. ` +
      `Le aviso a la doctora para que te contacte directo. 🙌`,
  },

  // ── Lista de espera ─────────────────────────────────────────────────────
  waitlist: {
    invite: ({ dateLabel }) =>
      `Por cierto: tu cita quedó para el *${dateLabel}*, que está algo lejos 🗓️.\n\n` +
      `Si otra paciente cancela y se libera un espacio más cercano, la doctora puede ofrecértelo. ` +
      `¿Quieres que te anote en la *lista de espera*?\n\n` +
      `Tu cita actual queda igual — solo cambiaría si tú aceptas un nuevo horario.`,
    joined:
      `¡Lista! Ya estás en la lista de espera 🙌\n` +
      `Si se libera un espacio antes de tu cita y la doctora te lo asigna, te aviso por aquí ` +
      `para que decidas. Tu cita actual sigue en pie.`,
    inviteDeclined:
      `Perfecto, tu cita queda tal como está. 💛`,
    inviteExpired:
      `Esa invitación ya no está activa 🤔. Si necesitas algo más, escribe *ayuda*.`,

    offer: ({ dateLabel, timeLabel, locationLabel, oldDateLabel }) =>
      `🎉 ¡Buenas noticias! Se liberó un espacio y la doctora te lo está ofreciendo:\n\n` +
      `📅 ${dateLabel}\n` +
      `🕐 ${timeLabel}\n` +
      `📍 ${locationLabel}\n\n` +
      `Si lo aceptas, tu cita del ${oldDateLabel} se cambia a este nuevo horario. ¿Te acomoda?`,
    offerAccepted: ({ dateLabel, timeLabel }) =>
      `¡Listo! Tu cita quedó para el *${dateLabel}* a las *${timeLabel}* ✅\n` +
      `Te enviaré el recordatorio la noche anterior. 💛`,
    offerDeclined:
      `No hay problema 🙌. Tu cita original sigue en pie tal como estaba, y sigues en la lista de espera.`,
    offerGone:
      `Ese espacio ya no está disponible 🙏. Tu cita original sigue en pie tal como estaba.`,
  },

  // ── Recordatorio nocturno (texto, NO el template aprobado) ──────────────
  // El template oficial vive en Meta (docs/TEMPLATES.md); este texto es el
  // fallback dentro de la ventana de 24h y para pruebas con el número de test
  // de la Cloud API mientras el template no está aprobado.
  reminder: {
    body: ({ name, dateLabel, timeLabel, locationLabel }) =>
      `Hola ${name} 👋, te recuerdo tu cita con la ${config.DOCTOR_NAME}:\n\n` +
      `📅 Mañana ${dateLabel}\n` +
      `🕐 ${timeLabel}\n` +
      `📍 ${locationLabel}\n\n` +
      `¿Confirmas tu asistencia?`,
    confirmedReply:
      `¡Gracias por confirmar! Te esperamos mañana puntual. 💛`,
    cancelledReply:
      `Listo, cancelé tu cita y liberé el horario. Cuando quieras volver a agendar, aquí estoy. 🙌`,
    alreadyHandled:
      `Esa cita ya estaba resuelta — no hice ningún cambio. Si necesitas algo más, escribe *ayuda*. 🙌`,
    notFound:
      `No encontré la cita de ese recordatorio 🤔. Escribe *agendar* para sacar una nueva o *ayuda* para más opciones.`,
  },

  // ── Restricciones de alcance ────────────────────────────────────────────
  // El bot NO da consejos médicos. Si la paciente pregunta algo médico, redirige.
  outOfScope:
    `Para temas médicos, lo mejor es que lo platiques directamente con la doctora en tu consulta 💛.\n` +
    `Yo te puedo ayudar con *agendar*, *confirmar* o *cancelar* tu cita.`,

  // ── Notificaciones a la doctora ──────────────────────────────────────────
  // Se envían desde el número del bot a DOCTOR_PERSONAL_PHONE (toggles
  // NOTIFY_* en .env — ver notificationService). Plantillas;
  // la doctora ajustará la redacción antes de Fase 4.
  doctor: {
    newAppointmentNewPatient: ({ name, phone, dateLabel, timeLabel, locationLabel, typeLabel, durationMin, notes }) =>
      `🆕 *Nueva paciente agendada*\n\n` +
      `👤 ${name} (paciente nueva)\n` +
      `📞 +${phone}\n` +
      `📅 ${dateLabel}, ${timeLabel}\n` +
      `📍 ${locationLabel}\n` +
      `🏥 ${typeLabel} (${durationMin} min)\n\n` +
      `💬 *Notas de la paciente:*\n` +
      `${notes ?? 'Sin notas'}`,

    newAppointmentRecurring: ({ name, dateLabel, timeLabel, locationLabel, typeLabel, notes }) =>
      `📋 Cita agendada\n\n` +
      `${name} — ${dateLabel}, ${timeLabel}\n` +
      `${locationLabel} · ${typeLabel}` +
      (notes ? `\n💬 ${notes}` : ``),

    confirmation: ({ name, timeLabel, locationLabel }) =>
      `✅ ${name} confirmó su cita de mañana (${timeLabel}, ${locationLabel})`,

    cancellation: ({ name, dateLabel, timeLabel, locationLabel }) =>
      `❌ ${name} canceló su cita\n` +
      `📅 Era: ${dateLabel}, ${timeLabel} en ${locationLabel}\n` +
      `El horario quedó liberado.`,

    noResponse: ({ name, timeLabel, locationLabel, phone }) =>
      `⚠️ ${name} no ha confirmado su cita de mañana\n` +
      `📅 ${timeLabel}, ${locationLabel}\n` +
      `La cita sigue en pie. Revisa si quieres contactarla.\n` +
      `📞 +${phone}`,

    reschedule: ({ name, oldDateLabel, oldTimeLabel, newDateLabel, newTimeLabel, locationLabel }) =>
      `🔄 ${name} reagendó su cita\n` +
      `❌ Antes: ${oldDateLabel}, ${oldTimeLabel}\n` +
      `✅ Ahora: ${newDateLabel}, ${newTimeLabel}\n` +
      `📍 ${locationLabel}`,

    rescheduleEscalation: ({ name, phone, typeLabel, locationLabel }) =>
      `🔔 ${name} quiere reagendar su cita pero no encontré horarios disponibles\n` +
      `🏥 ${typeLabel} · ${locationLabel}\n` +
      `Su cita original sigue en pie. ¿Le marcas para acordar horario?\n` +
      `📞 +${phone}`,

    // ── Lista de espera (lado doctora) ──────────────────────────────────
    waitlistFreedHeadline: ({ name }) => `${name} canceló y su horario quedó libre.`,
    waitlistDeclinedHeadline: ({ name }) => `${name} no aceptó el horario que le ofreciste.`,

    // Cuerpo del aviso con botones "Ver lista de espera" / "Dejar libre"
    // (versión de sesión; el template doctor_waitlist_offer conserva el texto
    // aprobado "Elegir paciente" en su botón — mismo payload).
    waitlistPrompt: ({ headline, dateLabel, timeLabel, locationLabel, candidateCount }) =>
      `🔔 *Lista de espera*\n` +
      `${headline}\n\n` +
      `🕐 Horario disponible: ${dateLabel}, ${timeLabel}\n` +
      `📍 ${locationLabel}\n` +
      `👥 En lista de espera con cita más lejana: ${candidateCount}\n\n` +
      `¿Se lo ofrecemos a alguna paciente?`,

    // Lista completa en texto libre (actualización 23/09): la doctora elige
    // escribiendo el nombre — un List Message solo admite 10 opciones.
    waitlistListHeader: ({ dateLabel, timeLabel, locationLabel, count }) =>
      `📋 *Lista de espera* — horario del *${dateLabel}, ${timeLabel}* (${locationLabel})\n\n` +
      `${count === 1 ? 'Hay 1 paciente' : `Hay ${count} pacientes`} con cita posterior a ese horario, ` +
      `de la cita más cercana a la más lejana:`,
    waitlistListLine: ({ index, name, appointmentLabel, locationLabel }) =>
      `${index}. ${name} — ${appointmentLabel} · ${locationLabel}`,
    waitlistListFooter:
      `✍️ Escribe el nombre de una paciente para saber más detalles.`,

    // Detalle de la paciente elegida, con botones "Ofrecerle horario" /
    // "Dejar libre".
    waitlistPatientDetail: ({ slotLabel, slotLocationLabel, ...patient }) =>
      `${waitlistPatientInfo(patient)}\n\n` +
      `¿Le ofrezco el horario del *${slotLabel}* (${slotLocationLabel})?\n\n` +
      `_O escribe el nombre de otra paciente para seleccionarla._`,
    waitlistNameNotFound: ({ query }) =>
      `No encontré a "${query}" en la lista de espera de este horario 🤔.\n` +
      `Revisa cómo está escrito (con nombre y apellido basta) o escribe su número de la lista.`,
    waitlistNameAmbiguous: ({ lines }) =>
      `Encontré varias pacientes con ese nombre:

${lines}\n\n` +
      `Escribe su nombre completo o su número de la lista.`,
    waitlistOfferSent: ({ name }) =>
      `Le ofrecí el horario a ${name}. Te aviso en cuanto responda. ⏳`,
    waitlistOfferPendingPatient: ({ name }) =>
      `Esa oferta sigue esperando la respuesta de ${name}. Te aviso en cuanto conteste. ⏳`,
    waitlistSkipped:
      `Va — dejo el horario libre para quien agende normalmente. 👌`,
    waitlistOfferInactive:
      `Ese pendiente de lista de espera ya no está activo (ya se resolvió o el horario ya pasó).`,
    waitlistSlotTaken:
      `Ese horario ya se ocupó por otra vía, así que ya no se puede ofrecer. Cierro el pendiente. ✅`,
    waitlistNoCandidates:
      `Ya no hay pacientes elegibles en la lista de espera para ese horario — lo dejo libre. 👌`,
    waitlistSendFailed: ({ name }) =>
      `No pude enviarle la oferta a ${name} por un problema técnico. El horario sigue disponible — puedes intentar con otra paciente desde este mismo aviso.`,

    // ── Lista de espera a voluntad (revisión 25/09) ──────────────────────
    // La doctora escribe "lista de espera", elige a una paciente por nombre y
    // le busca un horario antes de su cita, sin que nadie haya cancelado.
    // Todo es respuesta a algo que ella acaba de escribir o tocar (ventana de
    // 24h abierta): mensajes de sesión, sin templates.
    waitlistGeneralHeader: ({ count }) =>
      `📋 *Lista de espera* — ${count === 1 ? 'hay 1 paciente' : `hay ${count} pacientes`}, ` +
      `de la cita más cercana a la más lejana:`,
    waitlistGeneralEmpty:
      `📋 La lista de espera está vacía: por ahora ninguna paciente con cita próxima está anotada.`,
    waitlistPatientDetailGeneral: (patient) =>
      `${waitlistPatientInfo(patient)}\n\n` +
      `¿Le busco un horario antes de su cita actual?\n\n` +
      `_O escribe el nombre de otra paciente para seleccionarla._`,
    // También cae aquí cualquier texto suyo que no sea un nombre (ej. un
    // "gracias" a una notificación): redacción que sirve para ambos casos.
    waitlistGeneralNameNotFound: ({ query }) =>
      `No reconocí "${query}" 🤔.\n` +
      `Si buscas a una paciente de la lista de espera, escribe su nombre o su número; ` +
      `para ver la lista completa escribe *lista de espera*.`,
    waitlistPickDate: ({ name, appointmentLabel, locationLabel }) =>
      `¿Qué día le ofreces a *${name}*? Su cita actual es el ${appointmentLabel} (${locationLabel}).\n\n` +
      `Estos son los días con espacio antes de esa fecha, en ambos consultorios:`,
    waitlistDateRowDescription: ({ locationLabel, count }) =>
      `${locationLabel} · ${count === 1 ? '1 horario' : `${count} horarios`}`,
    waitlistNoEarlierDates: ({ name, appointmentLabel, phone }) =>
      `No hay horarios libres antes de la cita de ${name} (${appointmentLabel}) 😕.\n` +
      `Si quieres darle un espacio fuera del horario normal, contáctala directo: 📞 +${phone}`,
    waitlistPickTime: ({ name, dateLabel, locationLabel }) =>
      `Horarios libres del *${dateLabel}* en ${locationLabel} para ${name}:`,
    waitlistDayFull:
      `Ese día ya no tiene horarios libres antes de su cita. Elige otro día:`,
    waitlistSlotNoLongerFree:
      `Ese horario ya se ocupó 😕. Elige otro:`,
    waitlistConfirmManualOffer: ({ name, slotLabel, slotLocationLabel, appointmentLabel, locationLabel }) =>
      `¿Le ofrezco a *${name}* este horario?\n\n` +
      `📅 ${slotLabel}\n` +
      `📍 ${slotLocationLabel}\n\n` +
      `Su cita actual: ${appointmentLabel} (${locationLabel}). Si acepta, se la cambio al nuevo horario; si no, su cita sigue igual.`,
    waitlistEntryInactive:
      `Esa paciente ya no está en la lista de espera (su cita cambió, se canceló o ya pasó). Escribe *lista de espera* para ver la lista actual.`,
    waitlistAlreadyOffered: ({ name, slotLabel }) =>
      `Ya le ofreciste a ${name} el horario del ${slotLabel} y estoy esperando su respuesta. Te aviso en cuanto conteste. ⏳`,
    waitlistSlotOfferedToOther: ({ name }) =>
      `Ese horario ya se lo ofreciste a ${name} y estoy esperando su respuesta. Elige otro horario o espera a que conteste. ⏳`,

    // Avisos iniciados por el bot (pueden salir por template doctor_alert →
    // versión de UNA línea para la variable {{1}}).
    waitlistNoMoreCandidates: ({ name, dateLabel, timeLabel }) =>
      `${name} no aceptó el horario que le ofreciste (${dateLabel}, ${timeLabel}) y ya no hay más pacientes elegibles en la lista de espera. El horario queda libre.`,
    waitlistSlotGoneNotice: ({ name, dateLabel, timeLabel }) =>
      `El horario que le ofreciste a ${name} (${dateLabel}, ${timeLabel}) ya se había ocupado por otra vía. Su cita original sigue en pie.`,

    // Meta no pudo entregar la oferta a la paciente (status failed): la
    // oferta regresa a la doctora y esa paciente queda excluida del hueco.
    waitlistOfferUndeliveredHeadline: ({ name }) =>
      `No se pudo entregar la oferta del horario a ${name} (WhatsApp no la entregó).`,
    waitlistOfferUndeliveredNoMore: ({ name, dateLabel, timeLabel }) =>
      `No se pudo entregar la oferta del horario (${dateLabel}, ${timeLabel}) a ${name} y ya no hay más pacientes elegibles en la lista de espera. El horario queda libre.`,

    // ── Recordatorio no entregado (status failed de Meta) ───────────────
    // Template doctor_reminder_undelivered (docs/TEMPLATES_23-09.md).
    reminderUndelivered: ({ name, dateLabel, timeLabel, locationLabel, phone }) =>
      `⚠️ *Recordatorio no entregado*\n` +
      `WhatsApp no pudo entregarle a ${name} el recordatorio de su cita:\n` +
      `📅 ${dateLabel}, ${timeLabel}\n` +
      `📍 ${locationLabel}\n\n` +
      `La cita sigue en pie, pero ella no sabe que debe confirmar. Te sugiero contactarla directamente.\n` +
      `📞 +${phone}`,
    reminderUndeliveredOneLine: ({ name, dateLabel, timeLabel, locationLabel, phone }) =>
      `WhatsApp no pudo entregarle a ${name} el recordatorio de su cita del ${dateLabel} a las ${timeLabel} (${locationLabel}). La cita sigue en pie; te sugiero contactarla directamente al +${phone}.`,

    // ── Cita quitada del calendario a mano (calendarSync) ───────────────
    // Con candidatas en lista de espera: headline del aviso doctor_waitlist_offer.
    // Sin candidatas: template doctor_calendar_removed (docs/TEMPLATES_23-09.md).
    calendarRemovedHeadline: ({ name }) =>
      `Quitaste de tu calendario la cita de ${name} y su horario quedó libre.`,
    calendarRemoved: ({ name, dateLabel, timeLabel, locationLabel }) =>
      `🗓️ *Cita quitada de tu calendario*\n` +
      `La cita de ${name} (${dateLabel}, ${timeLabel}, ${locationLabel}) ya no aparece en tu calendario.\n\n` +
      `La cancelé también en el asistente: no le enviaré recordatorio y el horario quedó libre para agendar.`,
    calendarRemovedOneLine: ({ name, dateLabel, timeLabel, locationLabel }) =>
      `La cita de ${name} (${dateLabel}, ${timeLabel}, ${locationLabel}) ya no aparece en tu calendario, así que la cancelé también en el asistente: no le enviaré recordatorio y el horario quedó libre.`,

    // Freno de seguridad del sync: demasiadas citas "movidas/borradas" a la
    // vez suele ser un problema de conexión con el calendario, no de la doctora.
    calendarSyncAnomalyOneLine: ({ anomalies, total }) =>
      `Al revisar tu calendario, ${anomalies} de ${total} citas aparecieron movidas o borradas a la vez. Por seguridad no cambié nada en el asistente; el equipo técnico debe revisar la conexión con el calendario.`,

    systemError: ({ context }) =>
      `⚠️ *Aviso técnico del bot*\n` +
      `Hubo un error procesando mensajes (${context}). ` +
      `Si una paciente te comenta que el bot no responde, este es el motivo. ` +
      `El equipo técnico ya puede revisar los logs.`,

    // Versiones de UNA línea para la variable {{1}} del template doctor_alert
    // (las variables de template de Meta no aceptan saltos de línea).
    rescheduleEscalationOneLine: ({ name, phone, typeLabel, locationLabel }) =>
      `${name} quiere reagendar su cita (${typeLabel}, ${locationLabel}) pero no encontré horarios disponibles. Su cita original sigue en pie. ¿Le marcas? Tel: +${phone}`,

    systemErrorOneLine: ({ context }) =>
      `Hubo un error técnico procesando mensajes (${context}). Si una paciente comenta que el bot no responde, este es el motivo. El equipo técnico ya puede revisar los logs.`,
  },
};

// Etiquetas de botones e IDs de payload usados por messageBuilder.
// Centralizadas aquí para evitar strings mágicos esparcidos por el código.
export const buttonLabels = {
  continue: 'Continuar ➡️',
  moreSlots: 'Ver más horarios ➡️',
  confirm: 'Confirmar ✅',
  cancel: 'Cancelar ❌',
  startOver: 'Empezar de nuevo 🔄',
  reminderConfirm: 'Sí, confirmo ✅',
  reminderCancel: 'Cancelar cita ❌',
  cancelYes: 'Sí, cancelar ❌',
  cancelNo: 'Conservar cita 💛',
  waitlistJoin: 'Sí, anótame 🙋‍♀️',
  waitlistNo: 'No, gracias',
  waitlistAccept: 'Sí, lo tomo ✅',
  waitlistDecline: 'No me acomoda',
  waitlistView: 'Ver lista de espera',
  waitlistPick: 'Ofrecerle horario',
  waitlistSkip: 'Dejar libre',
  waitlistFindSlot: 'Buscarle horario',
  waitlistSendOffer: 'Sí, ofrecérselo',
  waitlistOtherSlot: 'Otro horario',
  waitlistDaysList: 'Ver días',
  waitlistTimesList: 'Ver horarios',
  yes: 'Sí',
  no: 'No',
};
