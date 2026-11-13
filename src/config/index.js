import 'dotenv/config';
import { z } from 'zod';

const envBool = z
  .preprocess(
    (v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v),
    z.boolean(),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  TIMEZONE: z.string().default('America/Mexico_City'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),

  // WhatsApp Cloud API (Meta) — App → WhatsApp → API Setup en developers.facebook.com
  WHATSAPP_TOKEN: z.string().min(1, 'Token de acceso de la Cloud API (temporal o de system user)'),
  WHATSAPP_PHONE_NUMBER_ID: z
    .string()
    .regex(/^\d+$/, 'Phone Number ID numérico (NO es el número de teléfono)'),
  WHATSAPP_VERIFY_TOKEN: z
    .string()
    .min(8, 'String arbitrario ≥8 chars — debe coincidir con el configurado en Meta'),
  META_APP_SECRET: z.string().min(1, 'App Secret (App → Settings → Basic) para validar firmas de webhooks'),
  GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'Formato "v<major>.<minor>", ej. v25.0')
    .default('v25.0'),

  DOCTOR_PERSONAL_PHONE: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, 'Debe ser E.164 con "+", ej. +5215512345678'),
  DOCTOR_NAME: z.string().default('Dra. Ejemplo'),

  // CalDAV — opcionales a nivel schema para que el bot pueda arrancar sin
  // credenciales (agenda solo en MySQL, con warning al boot). Con la config
  // completa, el arranque verifica la conexión y falla fast si no responde.
  //
  // Calendarios: uno por consultorio (CALDAV_CALENDAR_<CONSULTORIO>), porque
  // la doctora organiza su agenda con un calendario por ubicación.
  // CALDAV_CALENDAR_NAME es el fallback para consultorios sin var propia
  // (útil en pruebas con un solo calendario).
  CALDAV_SERVER_URL: z.string().url().default('https://caldav.icloud.com'),
  CALDAV_USERNAME: z.string().optional(),
  CALDAV_APP_SPECIFIC_PASSWORD: z.string().optional(),
  CALDAV_CALENDAR_NAME: z.string().optional(),
  CALDAV_CALENDAR_SUR: z.string().optional(),
  CALDAV_CALENDAR_NORTE: z.string().optional(),

  // Google Calendar (service account) — para consultorios cuyo calendario
  // vive en Google en vez de iCloud (ej. Sur, compartido con la
  // secretaria que agenda desde Android). Si GOOGLE_CALENDAR_<SLUG> está
  // definido, ese consultorio se rutea a Google; si no, a CalDAV.
  // La llave privada va con los saltos de línea escapados como "\n".
  GOOGLE_SA_EMAIL: z.string().email().optional(),
  GOOGLE_SA_PRIVATE_KEY: z.string().optional(),
  GOOGLE_CALENDAR_SUR: z.string().optional(),
  GOOGLE_CALENDAR_NORTE: z.string().optional(),

  REMINDER_TIME: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Formato HH:MM en 24h')
    .default('20:00'),

  // Horas después del recordatorio para revisar quién no respondió y avisar
  // a la doctora (NOTIFY_NO_RESPONSE).
  REMINDER_FOLLOWUP_HOURS: z.coerce.number().int().positive().max(12).default(2),

  // Nombre del template aprobado por Meta para el recordatorio nocturno
  // (docs/TEMPLATES.md). Sin configurar, el recordatorio sale como mensaje
  // interactivo de sesión — suficiente en dev con el número de test, pero en
  // producción Meta lo rechaza fuera de la ventana de 24h (error 131047).
  REMINDER_TEMPLATE_NAME: z.string().optional(),

  // Notificaciones a la doctora DIRECTO por template doctor_* (docs/TEMPLATES.md)
  // en vez de mensaje de sesión — en producción su ventana de 24h casi siempre
  // está cerrada y Meta puede aceptar el mensaje de sesión y rechazarlo async
  // (se perdería en silencio). Encender SOLO cuando Meta haya aprobado los
  // templates; apagado, se usa mensaje de sesión y el rebote solo se loggea.
  DOCTOR_TEMPLATES_ENABLED: envBool.default(false),

  // Días hacia adelante que se exploran buscando fechas disponibles. La
  // agenda real se llena con ~1 mes de anticipación (E2E 22/08: con 21 días
  // solo aparecía una fecha); 60 cubre hasta ~2 meses sin costo perceptible.
  AVAILABILITY_SEARCH_DAYS: z.coerce.number().int().positive().max(180).default(60),

  // Lista de espera: se le ofrece unirse a la paciente cuando su cita queda a
  // este número de días (o más) de distancia.
  WAITLIST_MIN_DAYS_AHEAD: z.coerce.number().int().positive().default(7),

  // Nombre del template aprobado por Meta para ofrecer un hueco liberado a una
  // paciente de la lista de espera (docs/TEMPLATES.md, waitlist_slot_offer).
  // Sin configurar, la oferta sale como mensaje interactivo de sesión — en
  // producción la ventana de 24h de la paciente casi siempre estará cerrada.
  WAITLIST_OFFER_TEMPLATE_NAME: z.string().optional(),

  NOTIFY_NEW_APPOINTMENT: envBool.default(true),
  NOTIFY_CONFIRMATION: envBool.default(true),
  NOTIFY_CANCELLATION: envBool.default(true),
  NOTIFY_NO_RESPONSE: envBool.default(true),
  NOTIFY_RESCHEDULE: envBool.default(true),

  // MySQL
  MYSQL_HOST: z.string().min(1).default('localhost'),
  MYSQL_PORT: z.coerce.number().int().positive().default(3306),
  MYSQL_USER: z.string().min(1),
  MYSQL_PASSWORD: z.string().default(''),
  MYSQL_DATABASE: z.string().min(1),
  MYSQL_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),

  CONVERSATION_TIMEOUT_MIN: z.coerce.number().int().positive().default(30),
}).superRefine((env, ctx) => {
  // Rutear un consultorio a Google sin la service account es un error de
  // configuración seguro: fail fast al boot en vez de degradar en silencio.
  const usesGoogle = env.GOOGLE_CALENDAR_SUR || env.GOOGLE_CALENDAR_NORTE;
  if (usesGoogle && (!env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GOOGLE_SA_EMAIL'],
      message:
        'Hay GOOGLE_CALENDAR_* definido pero faltan GOOGLE_SA_EMAIL y/o GOOGLE_SA_PRIVATE_KEY (la service account de Google Cloud)',
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Configuración inválida — revisa tu archivo .env:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
