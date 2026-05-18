import { z } from 'zod';

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ADMIN_TELEGRAM_USER_ID: z.string().regex(/^\d+$/, 'must be numeric'),
  ADMIN_EMAIL: z.string().email(),

  OPENAI_API_KEY: z.string().min(1),

  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().default('google/gemma-3-4b-it'),

  RESEND_API_KEY: z.string().min(1),
  RESEND_FROM_EMAIL: z.string().email(),

  DB_PATH: z.string().default('./data/bot.db'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MEDIA_GROUP_FLUSH_MS: z.string().regex(/^\d+$/).default('2000'),
});

export interface Config {
  telegramBotToken: string;
  adminTelegramUserId: number;
  adminEmail: string;
  openaiApiKey: string;
  openrouterApiKey: string;
  openrouterModel: string;
  resendApiKey: string;
  resendFromEmail: string;
  dbPath: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  mediaGroupFlushMs: number;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  return {
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    adminTelegramUserId: Number(e.ADMIN_TELEGRAM_USER_ID),
    adminEmail: e.ADMIN_EMAIL,
    openaiApiKey: e.OPENAI_API_KEY,
    openrouterApiKey: e.OPENROUTER_API_KEY,
    openrouterModel: e.OPENROUTER_MODEL,
    resendApiKey: e.RESEND_API_KEY,
    resendFromEmail: e.RESEND_FROM_EMAIL,
    dbPath: e.DB_PATH,
    logLevel: e.LOG_LEVEL,
    mediaGroupFlushMs: Number(e.MEDIA_GROUP_FLUSH_MS),
  };
}
