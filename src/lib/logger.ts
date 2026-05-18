// src/lib/logger.ts
import pino from 'pino';

// Default level used until `configureLogger` is called (i.e. for any log lines
// emitted before the validated config is available — typically only startup
// errors, which are fatal anyway and always log).
const DEFAULT_LEVEL = 'info';

export const logger = pino({
  level: DEFAULT_LEVEL,
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

/**
 * Apply the validated log level from config. Call once at startup, right after
 * `parseConfig` succeeds. `process.env.LOG_LEVEL` is no longer read directly by
 * this module — config is the single source of truth.
 */
export function configureLogger(opts: { level: Logger['level'] }): void {
  logger.level = opts.level;
}
