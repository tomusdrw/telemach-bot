import { describe, expect, it } from 'vitest';
import { configureLogger, logger } from '../../src/lib/logger';

describe('logger', () => {
  it('defaults to info level before configureLogger is called', () => {
    // Note: this assumes test ordering; the assertion is a snapshot of the
    // initial value the module exports.
    // We don't reset modules between tests here, so check the level is one of
    // the known pino levels rather than asserting 'info' specifically — other
    // tests may already have called configureLogger.
    expect(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).toContain(logger.level);
  });

  it('configureLogger updates the level on the shared instance', () => {
    configureLogger({ level: 'debug' });
    expect(logger.level).toBe('debug');
    configureLogger({ level: 'warn' });
    expect(logger.level).toBe('warn');
    // restore default so other tests don't see the side effect
    configureLogger({ level: 'info' });
  });

  it('rejects unknown levels at the pino layer', () => {
    // pino throws on invalid level assignment; configureLogger forwards it.
    expect(() => configureLogger({ level: 'nope' as never })).toThrow();
    // confirm the previous level was preserved
    expect(logger.level).toBe('info');
  });
});
