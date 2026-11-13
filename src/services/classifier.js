/**
 * classifier — interpreta el input de la paciente en cada punto del flujo.
 *
 * Módulo puro (sin I/O): recibe el mensaje normalizado del webhook y el
 * contexto necesario (opciones ofrecidas), devuelve la interpretación o null
 * si no se reconoce. Quien decide qué hacer con eso es el flow/handler.
 *
 * Orden de procesamiento :
 *   1. Comandos especiales en texto libre (cancelar, atrás, ayuda) — los
 *      resuelve messageHandler con matchGlobalCommand ANTES de llegar aquí.
 *   2. Button reply / List reply: IDs estructurados (`type_primera_vez`,
 *      `slot_08/07/2026_10:00`) — confiables, tienen prioridad.
 *   3. Texto libre como fallback: número de opción ("2"), keyword
 *      ("sur"), o formato reconocible ("10:00").
 */

import consultationTypes from '../data/consultationTypes.json' with { type: 'json' };
import { LOCATION_KEYS, locationKeywords } from '../data/locations.js';
import { parseDDMMYYYY } from '../lib/dates.js';

const TYPE_KEYS = Object.keys(consultationTypes).filter((k) => !k.startsWith('_'));

// ─── Normalización ───────────────────────────────────────────────────────────

/**
 * Minúsculas, sin acentos, sin signos de puntuación comunes, espacios
 * colapsados. "¿Quiero AGENDAR, porfa!" → "quiero agendar porfa".
 */
function normalize(text) {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[¿?¡!.,;:()"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(normalizedText) {
  return normalizedText.length === 0 ? [] : normalizedText.split(' ');
}

function containsAnyWord(normalizedText, keywords) {
  const set = new Set(words(normalizedText));
  return keywords.some((kw) => set.has(kw));
}

/** Texto que es solo un número de opción ("2", "2.", "opcion 2"). */
function parseOptionNumber(normalizedText, optionCount) {
  const match = /^(?:opcion |la )?(\d{1,2})$/.exec(normalizedText);
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 1 && n <= optionCount ? n : null;
}

// ─── Comandos globales (disponibles en cualquier estado del flujo) ──────────

const GLOBAL_COMMANDS = {
  cancel: ['cancelar', 'cancela', 'salir', 'olvidalo', 'ya no'],
  back: ['atras', 'regresar', 'regresa', 'volver', 'anterior'],
  help: ['ayuda', 'help', 'info'],
};

/**
 * Detecta comandos especiales cuando el mensaje ES el comando (no lo detecta
 * dentro de frases largas — "quiero cancelar mi cita del martes" es intent,
 * no comando; eso lo resuelve classifyIdleIntent o el flujo activo).
 *
 * @param {string} text
 * @returns {'cancel' | 'back' | 'help' | null}
 */
export function matchGlobalCommand(text) {
  const normalized = normalize(text);
  if (words(normalized).length > 2) return null;

  for (const [command, forms] of Object.entries(GLOBAL_COMMANDS)) {
    if (forms.includes(normalized)) return command;
  }
  return null;
}

// ─── Intents en IDLE (sin flujo activo) ─────────────────────────────────────

const IDLE_KEYWORDS = {
  // El orden importa: "quiero cambiar mi cita" trae "cita" pero es reschedule.
  reschedule: ['reagendar', 'reagenda', 'cambiar', 'mover', 'recorrer'],
  cancel_appointment: ['cancelar', 'cancela', 'cancelacion'],
  schedule: ['agendar', 'agenda', 'cita', 'consulta', 'apartar', 'reservar', 'espacio'],
  help: ['ayuda', 'help', 'info', 'informacion', 'funciona'],
  greeting: ['hola', 'buenas', 'buenos', 'buen', 'hey', 'saludos', 'holi', 'que tal'],
};

/**
 * Clasifica el primer mensaje de una conversación (sin estado previo).
 *
 * @param {{ inputType: string, text: string }} message
 * @returns {'schedule' | 'cancel_appointment' | 'reschedule' | 'greeting' | 'help' | null}
 */
export function classifyIdleIntent(message) {
  if (message.inputType !== 'text') return null;
  const normalized = normalize(message.text);

  for (const [intent, keywords] of Object.entries(IDLE_KEYWORDS)) {
    if (containsAnyWord(normalized, keywords)) return intent;
  }
  return null;
}

// ─── SELECTING_TYPE ──────────────────────────────────────────────────────────

const TYPE_KEYWORDS = {
  primera_vez: ['primera', 'primer', 'nueva', 'nuevo', 'nunca'],
  subsecuente: ['subsecuente', 'seguimiento', 'control', 'revision', 'recurrente', 'regreso'],
};

/**
 * @param {{ inputType: string, text: string, listId?: string, buttonPayload?: string }} message
 * @returns {string | null}  Llave de consultationTypes ("primera_vez") o null
 */
export function classifyTypeSelection(message) {
  const structuredId = message.listId ?? message.buttonPayload;
  if (structuredId?.startsWith('type_')) {
    const key = structuredId.slice('type_'.length);
    return TYPE_KEYS.includes(key) ? key : null;
  }
  if (message.inputType !== 'text') return null;

  const normalized = normalize(message.text);

  const optionNumber = parseOptionNumber(normalized, TYPE_KEYS.length);
  if (optionNumber) return TYPE_KEYS[optionNumber - 1];

  for (const key of TYPE_KEYS) {
    if (containsAnyWord(normalized, TYPE_KEYWORDS[key] ?? [key])) return key;
  }
  return null;
}

// ─── SELECTING_LOCATION ──────────────────────────────────────────────────────

/**
 * @param {{ inputType: string, text: string, listId?: string, buttonPayload?: string }} message
 * @returns {string | null}  Slug de availability.json ("sur") o null
 */
export function classifyLocationSelection(message) {
  const structuredId = message.buttonPayload ?? message.listId;
  if (structuredId?.startsWith('loc_')) {
    const value = structuredId.slice('loc_'.length);
    return LOCATION_KEYS.find((loc) => loc === value) ?? null;
  }
  if (message.inputType !== 'text') return null;

  const normalized = normalize(message.text);

  const optionNumber = parseOptionNumber(normalized, LOCATION_KEYS.length);
  if (optionNumber) return LOCATION_KEYS[optionNumber - 1];

  // Keywords del JSON normalizadas igual que el texto (sin acentos), para que
  // "Clínica" en el JSON matchee "clinica" escrito por la paciente.
  return (
    LOCATION_KEYS.find((loc) =>
      containsAnyWord(normalized, locationKeywords(loc).map((kw) => normalize(kw))),
    ) ?? null
  );
}

// ─── SHOWING_LOCATION_INFO ───────────────────────────────────────────────────

const CONTINUE_FORMS = [
  'continuar', 'continua', 'continuo', 'seguir', 'sigue', 'sigamos', 'adelante',
  'listo', 'lista', 'ok', 'okay', 'va', 'vale', 'dale', 'sale', 'si', 'sii',
  'yes', 'claro', 'perfecto', 'gracias', 'entendido', 'enterada', 'de acuerdo',
];

/**
 * ¿La paciente quiere continuar tras leer las indicaciones del consultorio?
 * Botón `locinfo_continue` o cualquier forma corta de asentimiento.
 *
 * @param {{ inputType: string, text: string, buttonPayload?: string, listId?: string }} message
 * @returns {boolean}
 */
export function classifyLocationInfoContinue(message) {
  const structuredId = message.buttonPayload ?? message.listId;
  if (structuredId === 'locinfo_continue') return true;
  if (structuredId) return false;

  if (message.inputType !== 'text') return false;
  return CONTINUE_FORMS.includes(normalize(message.text));
}

// ─── SELECTING_DATE ──────────────────────────────────────────────────────────

/**
 * @param {{ inputType: string, text: string, listId?: string, buttonPayload?: string }} message
 * @param {Array<{ date: string }>} offeredDates  Las fechas que se le ofrecieron
 * @returns {string | null}  Fecha DD/MM/YYYY de las ofrecidas, o null
 */
export function classifyDateSelection(message, offeredDates) {
  const offered = offeredDates ?? [];

  const structuredId = message.listId ?? message.buttonPayload;
  if (structuredId?.startsWith('date_')) {
    const date = structuredId.slice('date_'.length);
    return offered.some((d) => d.date === date) ? date : null;
  }
  if (message.inputType !== 'text') return null;

  const normalized = normalize(message.text);

  const optionNumber = parseOptionNumber(normalized, offered.length);
  if (optionNumber) return offered[optionNumber - 1].date;

  // "08/07/2026" o "08/07" escritos a mano
  const dateMatch = /(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/.exec(normalized);
  if (dateMatch) {
    const dd = dateMatch[1].padStart(2, '0');
    const mm = dateMatch[2].padStart(2, '0');
    const hit = offered.find((d) =>
      dateMatch[3] ? d.date === `${dd}/${mm}/${dateMatch[3]}` : d.date.startsWith(`${dd}/${mm}/`),
    );
    if (hit && parseDDMMYYYY(hit.date)) return hit.date;
  }

  return null;
}

// ─── SELECTING_TIME ──────────────────────────────────────────────────────────

const SHOW_MORE_FORMS = [
  'mas', 'ver mas', 'mas horarios', 'ver mas horarios', 'mas opciones',
  'otros', 'otros horarios', 'siguientes', 'mas tarde',
];

/**
 * ¿La paciente pidió la siguiente página de horarios? Item `slot_more` del
 * List Message paginado, o texto tipo "más" / "ver más horarios".
 *
 * @param {{ inputType: string, text: string, listId?: string, buttonPayload?: string }} message
 * @returns {boolean}
 */
export function classifyShowMoreSlots(message) {
  const structuredId = message.listId ?? message.buttonPayload;
  if (structuredId === 'slot_more') return true;
  if (structuredId) return false;

  if (message.inputType !== 'text') return false;
  return SHOW_MORE_FORMS.includes(normalize(message.text));
}

/**
 * @param {{ inputType: string, text: string, listId?: string, buttonPayload?: string }} message
 * @param {string[]} offeredSlots  TODOS los slots libres del día ("HH:mm")
 * @param {string[]} [visibleSlots]  Los de la página mostrada — un número de
 *   opción ("2") se interpreta contra lo que la paciente VE; una hora escrita
 *   ("15:20") se acepta de cualquier página.
 * @returns {string | null}  Hora "HH:mm" de las ofrecidas, o null
 */
export function classifyTimeSelection(message, offeredSlots, visibleSlots) {
  const offered = offeredSlots ?? [];
  const visible = visibleSlots ?? offered;

  const structuredId = message.listId ?? message.buttonPayload;
  if (structuredId?.startsWith('slot_')) {
    // slot_{DD/MM/YYYY}_{HH:mm} → la hora es el último segmento
    const time = structuredId.slice(structuredId.lastIndexOf('_') + 1);
    return offered.includes(time) ? time : null;
  }
  if (message.inputType !== 'text') return null;

  const normalized = normalize(message.text);

  const optionNumber = parseOptionNumber(normalized, visible.length);
  if (optionNumber) return visible[optionNumber - 1];

  // "10:00", "a las 10", "10 30"
  const timeMatch = /\b(\d{1,2})(?:[:\s](\d{2}))?\b/.exec(normalized);
  if (timeMatch) {
    const hh = timeMatch[1].padStart(2, '0');
    const mm = timeMatch[2] ?? '00';
    const candidate = `${hh}:${mm}`;
    if (offered.includes(candidate)) return candidate;
  }

  return null;
}

// ─── COLLECTING_NAME ─────────────────────────────────────────────────────────

const MAX_NAME_LENGTH = 100;

/**
 * Valida un nombre completo: al menos dos palabras, solo letras (con acentos),
 * espacios, guiones y apóstrofes.
 *
 * @param {{ inputType: string, text: string }} message
 * @returns {string | null}  El nombre limpio o null si no es válido
 */
export function classifyName(message) {
  if (message.inputType !== 'text') return null;

  const name = (message.text ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 5 || name.length > MAX_NAME_LENGTH) return null;
  if (!/^[\p{L}][\p{L}'’-]*(?: [\p{L}][\p{L}'’-]*)+$/u.test(name)) return null;

  return name;
}

// ─── COLLECTING_NOTES ────────────────────────────────────────────────────────

const NO_NOTES_FORMS = ['no', 'n', 'nada', 'ninguna', 'ninguno', 'no gracias', 'sin notas', 'nel', 'nop'];

// Tope para que el resumen de confirmación no rebase los 1024 chars del body.
const MAX_NOTES_LENGTH = 500;

/**
 * @param {{ inputType: string, text: string }} message
 * @returns {{ notes: string | null } | null}  null si el input no es texto;
 *   { notes: null } si la paciente dijo que no tiene notas.
 */
export function classifyNotes(message) {
  if (message.inputType !== 'text') return null;

  const raw = (message.text ?? '').trim();
  if (raw.length === 0) return null;

  if (NO_NOTES_FORMS.includes(normalize(raw))) return { notes: null };

  const notes = raw.length > MAX_NOTES_LENGTH ? `${raw.slice(0, MAX_NOTES_LENGTH)}…` : raw;
  return { notes };
}

// ─── Selección de cita activa (cancelar / reagendar) ────────────────────────

/**
 * Interpreta la elección de una cita entre las ofrecidas (IDs `appt_{uuid}`
 * de buildAppointmentSelectionMessage, o número de opción en texto).
 *
 * @param {{ inputType: string, text: string, listId?: string, buttonPayload?: string }} message
 * @param {Array<{ id: string }>} offeredAppointments
 * @returns {string | null}  UUID de la cita elegida, o null
 */
export function classifyAppointmentSelection(message, offeredAppointments) {
  const offered = offeredAppointments ?? [];

  const structuredId = message.listId ?? message.buttonPayload;
  if (structuredId?.startsWith('appt_')) {
    const id = structuredId.slice('appt_'.length);
    return offered.some((a) => a.id === id) ? id : null;
  }
  if (message.inputType !== 'text') return null;

  const normalized = normalize(message.text);
  const optionNumber = parseOptionNumber(normalized, offered.length);
  return optionNumber ? offered[optionNumber - 1].id : null;
}

/**
 * Decisión sí/no sobre cancelar una cita específica. Estructurado:
 * cancel_yes_{id} / cancel_no_{id} (validado contra la cita en contexto);
 * texto libre: mismas formas que la confirmación de agendado.
 *
 * @param {{ inputType: string, text: string, buttonPayload?: string, listId?: string }} message
 * @param {string} appointmentId  La cita que se está confirmando cancelar
 * @returns {'yes' | 'no' | null}
 */
export function classifyCancelDecision(message, appointmentId) {
  const structuredId = message.buttonPayload ?? message.listId;
  if (structuredId === `cancel_yes_${appointmentId}`) return 'yes';
  if (structuredId === `cancel_no_${appointmentId}`) return 'no';
  if (structuredId) return null;

  if (message.inputType !== 'text') return null;
  const normalized = normalize(message.text);

  if (CONFIRMATION_FORMS.yes.includes(normalized)) return 'yes';
  if (CONFIRMATION_FORMS.no.includes(normalized)) return 'no';
  return null;
}

// ─── CONFIRMING ──────────────────────────────────────────────────────────────

const CONFIRMATION_FORMS = {
  yes: ['si', 'sii', 'confirmo', 'confirmar', 'correcto', 'ok', 'okay', 'va', 'sale', 'claro', 'yes', 'dale', 'perfecto'],
  no: ['no', 'nel', 'nop', 'ya no'],
  restart: ['de nuevo', 'empezar de nuevo', 'reiniciar', 'otra vez', 'reinicia', 'restart'],
};

/**
 * @param {{ inputType: string, text: string, buttonPayload?: string, listId?: string }} message
 * @returns {'yes' | 'no' | 'restart' | null}
 */
export function classifyConfirmation(message) {
  const structuredId = message.buttonPayload ?? message.listId;
  if (structuredId === 'confirm_yes') return 'yes';
  if (structuredId === 'confirm_no') return 'no';
  if (structuredId === 'confirm_restart') return 'restart';
  if (structuredId) return null;

  if (message.inputType !== 'text') return null;
  const normalized = normalize(message.text);

  for (const [decision, forms] of Object.entries(CONFIRMATION_FORMS)) {
    if (forms.includes(normalized)) return decision;
  }
  return null;
}

// ─── Lista de espera: la doctora escribe el nombre de una paciente ──────────

// Palabras de relleno que la doctora podría agregar ("la paciente Paola",
// "elijo a Paola"): cuentan como opcionales si el nombre no las contiene.
const WAITLIST_FILLER_WORDS = new Set([
  'a', 'la', 'el', 'de', 'del', 'paciente', 'sra', 'senora', 'srita', 'senorita',
  'elijo', 'quiero', 'ella', 'esta', 'porfa', 'por', 'favor',
]);

// Prefijo mínimo para aceptar un token parcial ("Pao" → "Paola").
const MIN_PREFIX_LENGTH = 3;

/**
 * Interpreta el texto de la doctora mientras ve la lista de espera: número
 * de la lista ("3") o nombre de la paciente, sin acentos ni mayúsculas, con
 * tokens parciales ("pao hdz" no, "paola hern" sí).
 *
 * Una coincidencia exacta del nombre completo gana sobre las parciales
 * ("Ana López" no es ambigua frente a "Ana López Pérez").
 *
 * @param {{ inputType: string, text: string }} message
 * @param {Array<{ patientName: string }>} candidates  En el orden mostrado (numeración 1..N)
 * @returns {{ kind: 'match', entry: object } | { kind: 'ambiguous', entries: object[] } | { kind: 'none' }}
 */
export function classifyWaitlistPatient(message, candidates) {
  if (message.inputType !== 'text' || candidates.length === 0) return { kind: 'none' };
  const normalized = normalize(message.text);
  if (normalized.length === 0) return { kind: 'none' };

  const optionNumber = parseOptionNumber(normalized, candidates.length);
  if (optionNumber) return { kind: 'match', entry: candidates[optionNumber - 1] };

  const exact = candidates.filter((c) => normalize(c.patientName) === normalized);
  if (exact.length === 1) return { kind: 'match', entry: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', entries: exact };

  const queryTokens = words(normalized);
  const matches = candidates.filter((c) => nameMatchesTokens(normalize(c.patientName), queryTokens));
  if (matches.length === 1) return { kind: 'match', entry: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', entries: matches };
  return { kind: 'none' };
}

function nameMatchesTokens(normalizedName, queryTokens) {
  const nameTokens = words(normalizedName);
  const tokenMatches = (token) => nameTokens.some(
    (nameToken) => nameToken === token
      || (token.length >= MIN_PREFIX_LENGTH && nameToken.startsWith(token)),
  );

  const meaningful = queryTokens.filter((t) => !WAITLIST_FILLER_WORDS.has(t) || tokenMatches(t));
  return meaningful.length > 0 && meaningful.every(tokenMatches);
}

// ─── Lista de espera a voluntad: comando de la doctora ──────────────────────

// Frases cortas: "lista de espera", "ver la lista de espera", "¿quién está en
// la lista de espera?". Un mensaje largo que solo menciona la lista no es el
// comando.
const WAITLIST_COMMAND_MAX_WORDS = 8;

/**
 * ¿El texto es el comando para ver la lista de espera completa? Solo aplica a
 * la doctora (lo decide quien llama).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isWaitlistCommand(text) {
  const normalized = normalize(text);
  if (words(normalized).length > WAITLIST_COMMAND_MAX_WORDS) return false;
  return /\blista (?:de )?espera\b/.test(normalized);
}
