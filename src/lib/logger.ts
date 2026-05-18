// src/lib/logger.ts
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  base: { service: 'telemach-bot' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'err.detail.headers.authorization',
      'err.detail.headers.Authorization',
      'err.detail.config.headers.authorization',
      'err.detail.config.headers.Authorization',
      'err.detail.request.headers.authorization',
      'err.detail.request.headers.Authorization',
      '*.apiKey',
      '*.api_key',
      '*.token',
      '*.access_token',
      'ctxUpdate.message.text',
      'ctxUpdate.message.caption',
      'ctxUpdate.edited_message.text',
      'ctxUpdate.edited_message.caption',
      'ctxUpdate.channel_post.text',
      'ctxUpdate.channel_post.caption',
    ],
    censor: '[REDACTED]',
  },
});

export type Logger = typeof logger;
