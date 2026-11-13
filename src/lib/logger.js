import pino from 'pino';
import { config } from '../config/index.js';

const isDev = config.NODE_ENV !== 'production';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { env: config.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname,env',
        singleLine: false,
      },
    },
  }),
});
