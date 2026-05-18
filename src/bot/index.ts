// src/bot/index.ts
import { Bot, type Context } from 'grammy';
import type { Config } from '../config';
import { UserRepo } from '../db/users';
import { handleStart, handleRegister, handlePlainMessage } from './onboarding';
import { makeAdminModule } from './admin';
import { makeForwardHandler } from './forward';
import { makeTranscriptionClient } from '../services/transcription';
import { makeSubjectClient } from '../services/subject';
import { makeResendClient, defaultResendClient } from '../services/resend';
import { downloadTelegramFile } from '../services/telegram-files';
import { logger } from '../lib/logger';

export function buildBot(config: Config, repo: UserRepo): Bot {
  const bot = new Bot(config.telegramBotToken);

  const transcription = makeTranscriptionClient({
    apiKey: config.openrouterApiKey,
    model: config.openrouterTranscriptionModel,
  });
  const subject = makeSubjectClient({
    apiKey: config.openrouterApiKey,
    model: config.openrouterModel,
  });
  const resend = makeResendClient(defaultResendClient(config.resendApiKey));

  const admin = makeAdminModule({
    api: bot.api,
    adminTelegramUserId: config.adminTelegramUserId,
    repo,
  });

  const forward = makeForwardHandler({
    repo,
    fromEmail: config.resendFromEmail,
    botToken: config.telegramBotToken,
    api: bot.api,
    subject,
    transcription,
    resend,
    download: ({ api, botToken, fileId }) => downloadTelegramFile({ api, botToken, fileId }),
    mediaGroupFlushMs: config.mediaGroupFlushMs,
    retryDelays: [500, 2000, 8000],
  });

  // Commands first so they don't get caught by the plain-message handler.
  bot.command('start', (ctx) => handleStart(ctx, { repo, notify: admin.notifyAdminOfNewUser }));
  bot.command('register', (ctx) => {
    const arg = String(ctx.match).trim();
    return handleRegister(ctx, {
      repo,
      notify: admin.notifyAdminOfNewUser,
      emailArg: arg,
    });
  });

  bot.callbackQuery(/^(approve|reject):\d+$/, (ctx) => admin.handleCallback(ctx));

  bot.on('message', async (ctx: Context) => {
    const out = await handlePlainMessage(ctx, { repo, notify: admin.notifyAdminOfNewUser });
    if (out.forwardToApprovedFlow) await forward(ctx);
  });

  bot.catch((err) => {
    logger.error({ err: err.error, ctxUpdate: err.ctx.update }, 'unhandled bot error');
  });

  return bot;
}
