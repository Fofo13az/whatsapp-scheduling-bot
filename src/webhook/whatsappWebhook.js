import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { handleIncomingMessage } from '../handlers/messageHandler.js';
import { handleStatusUpdate } from '../handlers/statusHandler.js';

const log = logger.child({ module: 'whatsappWebhook' });

export const whatsappWebhookRouter = Router();

/**
 * GET /webhook/whatsapp — verificación del webhook.
 *
 * Al registrar la URL en Meta for Developers (App → WhatsApp → Configuration),
 * Meta manda un GET con hub.mode, hub.verify_token y hub.challenge. Si el
 * verify_token coincide con el nuestro, respondemos el challenge en texto
 * plano y el webhook queda suscrito. Es un handshake de una sola vez (y cada
 * vez que se edita la URL en la consola).
 */
whatsappWebhookRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.WHATSAPP_VERIFY_TOKEN) {
    log.info('Webhook verificado por Meta');
    return res.status(200).send(challenge);
  }

  log.warn({ mode }, 'Intento de verificación de webhook con token inválido');
  return res.sendStatus(403);
});

/**
 * POST /webhook/whatsapp — mensajes entrantes.
 *
 * Meta envía un POST JSON por cada evento del número (mensajes entrantes,
 * pero también statuses de entrega de los salientes). El handler:
 *   1. Verifica la firma HMAC SHA256 (header X-Hub-Signature-256) contra el
 *      App Secret, sobre el body crudo byte a byte.
 *   2. Extrae y normaliza los mensajes (texto, button_reply, list_reply).
 *   3. Extrae los statuses de entrega de los salientes (statusHandler: detecta
 *      recordatorios y ofertas que Meta aceptó pero NO entregó).
 *   4. Responde 200 rápido; el procesamiento corre async aparte.
 *
 * En desarrollo, si la firma falla, se loggea pero no se rechaza — facilita
 * probar con curl. En producción, firma inválida = 403.
 *
 * Nota: Meta reintenta entregas no confirmadas, por lo que un mismo mensaje
 * puede llegar dos veces. El dedupe por wamid vive en messageHandler.
 */
whatsappWebhookRouter.post('/', (req, res) => {
  const isProd = config.NODE_ENV === 'production';
  const signatureOk = isValidSignature(req.rawBody, req.header('X-Hub-Signature-256'));

  if (!signatureOk) {
    if (isProd) {
      log.warn({ ip: req.ip }, 'Firma X-Hub-Signature-256 inválida o ausente — rechazado');
      return res.sendStatus(403);
    }
    log.warn('Firma X-Hub-Signature-256 inválida o ausente (permitido en dev)');
  }

  const { messages: incoming, statuses } = extractWebhookEvents(req.body);

  for (const message of incoming) {
    log.info({ message }, 'Mensaje entrante');

    // Fire-and-forget para no bloquear el ack 200 a Meta. handleIncomingMessage
    // maneja sus propios errores (incluido avisar a la paciente); este catch es
    // solo la última red por si algo se escapa.
    handleIncomingMessage(message).catch((err) =>
      log.error({ err }, 'Error no capturado en messageHandler'),
    );
  }

  for (const status of statuses) {
    // Mismo patrón fire-and-forget; handleStatusUpdate nunca lanza.
    handleStatusUpdate(status).catch((err) =>
      log.error({ err }, 'Error no capturado en statusHandler'),
    );
  }

  // Ack inmediato. Meta reintenta si no recibe 200 rápido; las respuestas
  // al usuario corren async aparte.
  return res.sendStatus(200);
});

/**
 * Verifica la firma del webhook: HMAC SHA256 del body crudo con el App Secret,
 * en formato "sha256=<hex>". Comparación en tiempo constante.
 *
 * @param {Buffer | undefined} rawBody  Capturado por el `verify` de express.json
 * @param {string | undefined} header   Valor de X-Hub-Signature-256
 */
function isValidSignature(rawBody, header) {
  if (!rawBody || !header?.startsWith('sha256=')) return false;

  const expected = crypto
    .createHmac('sha256', config.META_APP_SECRET)
    .update(rawBody)
    .digest('hex');
  const received = header.slice('sha256='.length);

  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(received, 'hex');
  return (
    expectedBuf.length === receivedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, receivedBuf)
  );
}

/**
 * Extrae del payload de Meta los mensajes entrantes (normalizados a la
 * estructura uniforme que consume el resto del código) y los statuses de
 * entrega de los mensajes salientes (tal cual los manda Meta).
 *
 * Estructura del payload: entry[] → changes[] → value, donde value trae
 * `messages[]` (entrantes) y/o `statuses[]` (acuses de entrega de salientes).
 *
 * @param {object} body
 * @returns {{ messages: Array<object>, statuses: Array<object> }}
 */
function extractWebhookEvents(body) {
  const result = { messages: [], statuses: [] };
  if (body?.object !== 'whatsapp_business_account') return result;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value ?? {};

      result.statuses.push(...(value.statuses ?? []));

      for (const msg of value.messages ?? []) {
        result.messages.push(normalizeMessage(msg, value.contacts ?? []));
      }
    }
  }

  return result;
}

/**
 * Convierte un mensaje raw de la Cloud API a la estructura uniforme.
 *
 * Meta reporta el tipo de input en `message.type`:
 *   - "interactive" + interactive.type "button_reply" → tocó un Reply Button.
 *   - "interactive" + interactive.type "list_reply"   → tocó opción de List Message.
 *   - "button"  → tocó un Quick Reply de un TEMPLATE (ej. recordatorio nocturno).
 *   - "text"    → texto libre.
 *   - otros (image, audio, location...) → inputType "unsupported".
 *
 * `buttonPayload` y `listId` tienen prioridad sobre `text` al procesar:
 * son input estructurado, mucho más confiable que parsear texto.
 *
 * @param {object} msg       Elemento de value.messages[]
 * @param {object[]} contacts  value.contacts[] (trae el nombre de perfil)
 */
function normalizeMessage(msg, contacts) {
  const contact = contacts.find((c) => c.wa_id === msg.from) ?? contacts[0] ?? null;

  let inputType = 'text';
  let text = msg.text?.body ?? '';
  let buttonPayload = null;
  let buttonText = null;
  let listId = null;
  let listTitle = null;

  if (msg.type === 'interactive' && msg.interactive?.type === 'button_reply') {
    inputType = 'button';
    buttonPayload = msg.interactive.button_reply?.id ?? null;
    buttonText = msg.interactive.button_reply?.title ?? null;
    text = buttonText ?? '';
  } else if (msg.type === 'interactive' && msg.interactive?.type === 'list_reply') {
    inputType = 'list';
    listId = msg.interactive.list_reply?.id ?? null;
    listTitle = msg.interactive.list_reply?.title ?? null;
    text = listTitle ?? '';
  } else if (msg.type === 'button') {
    // Quick Reply de un template (los interactivos de sesión llegan como "interactive")
    inputType = 'button';
    buttonPayload = msg.button?.payload ?? null;
    buttonText = msg.button?.text ?? null;
    text = buttonText ?? '';
  } else if (msg.type !== 'text') {
    inputType = 'unsupported';
  }

  return {
    inputType,
    from: msg.from,               // wa_id: dígitos sin "+" (ej. "5215512345678")
    profileName: contact?.profile?.name ?? null,
    waId: msg.from,
    messageId: msg.id ?? null,    // wamid — messageHandler dedupea con esto
    timestamp: msg.timestamp ?? null,
    rawType: msg.type,
    text,
    buttonPayload,
    buttonText,
    listId,
    listTitle,
  };
}
