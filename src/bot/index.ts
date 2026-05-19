// src/bot/index.ts
import { Bot, type Context } from 'grammy';
import type { Config } from '../config.js';
import type { UserRepo } from '../db/users.js';
import { logger } from '../lib/logger.js';
import { defaultResendClient, makeResendClient } from '../services/resend.js';
import { makeSubjectClient } from '../services/subject.js';
import { downloadTelegramFile } from '../services/telegram-files.js';
import { makeTranscriptionClient } from '../services/transcription.js';
import { makeAdminModule } from './admin.js';
import { type ForwardHandler, makeForwardHandler } from './forward.js';
import { handlePlainMessage, handleRegister, handleStart } from './onboarding.js';

export interface BuiltBot {
  bot: Bot;
  forward: ForwardHandler;
}

export function buildBot(config: Config, repo: UserRepo): BuiltBot {
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

  bot.command('users', (ctx) => admin.handleUsersCommand(ctx));
  bot.command('revoke', (ctx) => admin.handleRevokeCommand(ctx, String(ctx.match).trim()));
  bot.command('reset', (ctx) => admin.handleResetCommand(ctx, String(ctx.match).trim()));

  bot.callbackQuery(/^(approve|reject):\d+$/, (ctx) => admin.handleCallback(ctx));

  bot.on('message', async (ctx: Context) => {
    const out = await handlePlainMessage(ctx, { repo, notify: admin.notifyAdminOfNewUser });
    if (out.forwardToApprovedFlow) await forward(ctx);
  });

  bot.catch((err) => {
    logger.error({ err: err.error, ctxUpdate: err.ctx.update }, 'unhandled bot error');
  });

  return { bot, forward };
}
