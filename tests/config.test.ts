import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';

const baseEnv = {
  TELEGRAM_BOT_TOKEN: 'token',
  ADMIN_TELEGRAM_USER_ID: '12345',
  ADMIN_EMAIL: 'admin@example.com',
  OPENROUTER_API_KEY: 'or-x',
  RESEND_API_KEY: 're-x',
  RESEND_FROM_EMAIL: 'bot@example.com',
};

describe('parseConfig', () => {
  it('parses a valid env and applies defaults', () => {
    const cfg = parseConfig(baseEnv);
    expect(cfg.telegramBotToken).toBe('token');
    expect(cfg.adminTelegramUserId).toBe(12345);
    expect(cfg.adminEmail).toBe('admin@example.com');
    expect(cfg.openrouterModel).toBe('google/gemma-3-4b-it');
    expect(cfg.openrouterTranscriptionModel).toBe('openai/whisper-large-v3');
    expect(cfg.dbPath).toBe('./data/bot.db');
    expect(cfg.mediaGroupFlushMs).toBe(2000);
    expect(cfg.logLevel).toBe('info');
  });

  it('throws when a required var is missing', () => {
    const { TELEGRAM_BOT_TOKEN, ...rest } = baseEnv;
    expect(() => parseConfig(rest)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('throws when ADMIN_TELEGRAM_USER_ID is not numeric', () => {
    expect(() => parseConfig({ ...baseEnv, ADMIN_TELEGRAM_USER_ID: 'abc' })).toThrow(
      /ADMIN_TELEGRAM_USER_ID/,
    );
  });

  it('throws when ADMIN_EMAIL is not an email', () => {
    expect(() => parseConfig({ ...baseEnv, ADMIN_EMAIL: 'notanemail' })).toThrow(/ADMIN_EMAIL/);
  });

  it('throws when OPENROUTER_API_KEY is missing', () => {
    const { OPENROUTER_API_KEY, ...rest } = baseEnv;
    expect(() => parseConfig(rest)).toThrow(/OPENROUTER_API_KEY/);
  });

  it('respects an explicit OPENROUTER_TRANSCRIPTION_MODEL override', () => {
    const cfg = parseConfig({ ...baseEnv, OPENROUTER_TRANSCRIPTION_MODEL: 'some/other-stt' });
    expect(cfg.openrouterTranscriptionModel).toBe('some/other-stt');
  });

  it('EVENT_MODEL defaults to OPENROUTER_MODEL when unset', () => {
    const cfg = parseConfig({
      ...baseEnv,
      OPENROUTER_MODEL: 'special/model',
    });
    expect(cfg.eventModel).toBe('special/model');
  });

  it('EVENT_MODEL is used when set', () => {
    const cfg = parseConfig({
      ...baseEnv,
      OPENROUTER_MODEL: 'subject/m',
      EVENT_MODEL: 'event/m',
    });
    expect(cfg.eventModel).toBe('event/m');
  });
});
