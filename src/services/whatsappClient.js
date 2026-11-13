/**
 * Cliente de la WhatsApp Cloud API de Meta (Graph API) para mensajes salientes.
 *
 * Traduce los payloads neutrales de `messageBuilder` al wire format JSON de
 * la Cloud API y los envía con `fetch` nativo (Node 20+, sin dependencias).
 *
 * A diferencia de Twilio, los mensajes interactivos (buttons | list) dentro
 * de la ventana de 24h NO requieren templates pre-aprobados: se mandan como
 * JSON libre con `type: "interactive"`. Los templates de Meta solo se
 * necesitan para mensajes iniciados por el bot fuera de ventana (recordatorio
 * nocturno — ver `sendTemplate`, Fase 3).
 *
 * Todos los errores se loggean con contexto (código de Meta, fbtrace_id) y se
 * re-throwean para que el caller decida cómo manejarlos.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */

import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'whatsappClient' });

const MESSAGES_URL = `https://graph.facebook.com/${config.GRAPH_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

/**
 * La Cloud API espera el destinatario como dígitos (E.164 sin "+").
 * Aceptamos E.164 con o sin "+" y normalizamos quitándolo.
 *
 * Caso México: los wa_id de celulares mexicanos traen el "1" histórico tras
 * el código de país ("521" + 10 dígitos), pero la Cloud API registra y
 * compara los números en formato moderno ("52" + 10 dígitos). Sin esta
 * normalización, responderle al wa_id truena con el error 131030
 * ("recipient not in allowed list") en el número de test.
 */
function normalizeRecipient(to) {
  let digits = to.startsWith('+') ? to.slice(1) : to;
  if (digits.startsWith('521') && digits.length === 13) {
    digits = `52${digits.slice(3)}`;
  }
  return digits;
}

/**
 * Envía un mensaje al usuario vía WhatsApp Cloud API.
 *
 * @param {object} payload  Output de cualquier builder de messageBuilder.
 * @returns {Promise<{ messageId: string }>}  El wamid asignado por Meta.
 */
export async function sendMessage(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('whatsappClient.sendMessage: payload requerido');
  }

  let body;
  if (payload.type === 'text') {
    body = buildTextBody(payload);
  } else if (payload.type === 'buttons') {
    body = buildButtonsBody(payload);
  } else if (payload.type === 'list') {
    body = buildListBody(payload);
  } else {
    throw new Error(`whatsappClient.sendMessage: tipo de payload desconocido "${payload.type}"`);
  }

  const result = await postToGraph(body, {
    to: payload.to,
    type: payload.type,
    kind: payload.kind ?? null,
  });

  return { messageId: result.messages?.[0]?.id ?? null };
}

/**
 * Envía un template pre-aprobado de Meta (mensajes iniciados por el bot,
 * fuera de la ventana de 24h — ej. el recordatorio nocturno).
 *
 * TODO Fase 3: usar para `appointment_reminder` cuando el template esté
 * aprobado. Los `components` siguen el formato de la Cloud API.
 *
 * @param {string} to
 * @param {string} templateName
 * @param {object[]} [components]  Variables del template (body params, botones)
 * @param {string} [languageCode]
 * @returns {Promise<{ messageId: string }>}
 */
export async function sendTemplate(to, templateName, components = [], languageCode = 'es_MX') {
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizeRecipient(to),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length > 0 && { components }),
    },
  };

  const result = await postToGraph(body, { to, type: 'template', kind: templateName });
  return { messageId: result.messages?.[0]?.id ?? null };
}

// ─── Traducción payload neutral → wire format Cloud API ─────────────────────

function buildTextBody(payload) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizeRecipient(payload.to),
    type: 'text',
    text: { preview_url: false, body: payload.body },
  };
}

function buildButtonsBody(payload) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizeRecipient(payload.to),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: payload.body },
      action: {
        buttons: payload.buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.label },
        })),
      },
    },
  };
}

function buildListBody(payload) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizeRecipient(payload.to),
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: payload.body },
      action: {
        button: payload.buttonText,
        sections: payload.sections.map((section) => ({
          title: section.title,
          rows: section.items.map((item) => ({
            id: item.id,
            title: item.label,
            ...(item.description && { description: item.description }),
          })),
        })),
      },
    },
  };
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/**
 * POST a la Graph API con manejo de errores uniforme.
 *
 * Los errores de Meta vienen como { error: { message, type, code,
 * error_subcode, fbtrace_id } }. El `fbtrace_id` sirve para soporte de Meta;
 * el `code` para diagnosticar (ej. 190 = token inválido/expirado,
 * 131030 = destinatario no está en la lista de números de prueba).
 *
 * @param {object} body        Wire format de la Cloud API
 * @param {object} logContext  Campos extra para el log (to, type, kind)
 */
async function postToGraph(body, logContext) {
  let response;
  let data;

  try {
    response = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    data = await response.json();
  } catch (err) {
    log.error({ err, ...logContext }, 'Fallo de red al llamar a la Cloud API');
    throw err;
  }

  if (!response.ok) {
    const metaError = data?.error ?? {};
    log.error(
      {
        ...logContext,
        httpStatus: response.status,
        metaCode: metaError.code ?? null,
        metaSubcode: metaError.error_subcode ?? null,
        metaMessage: metaError.message ?? null,
        fbtraceId: metaError.fbtrace_id ?? null,
      },
      'Fallo envío de mensaje',
    );
    const err = new Error(
      `whatsappClient: Cloud API respondió ${response.status} — ${metaError.message ?? 'sin detalle'}`,
    );
    err.metaCode = metaError.code;
    err.fbtraceId = metaError.fbtrace_id;
    throw err;
  }

  log.info(
    { ...logContext, messageId: data.messages?.[0]?.id ?? null },
    'Mensaje enviado',
  );
  return data;
}
