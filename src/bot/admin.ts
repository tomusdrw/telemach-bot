import type { Api } from 'grammy';
import { UserRepo } from '../db/users';
import { logger } from '../lib/logger';

export interface AdminModuleOpts {
  api: Api;
  adminTelegramUserId: number;
  repo: UserRepo;
}

export interface NotifyAdminInput {
  telegramId: number;
  username: string | null;
  firstName: string | null;
  email: string;
}

export interface AdminModule {
  notifyAdminOfNewUser(input: NotifyAdminInput): Promise<void>;
  handleCallback(ctx: AdminCallbackCtx): Promise<void>;
}

interface AdminCallbackCtx {
  from?: { id: number };
  callbackQuery?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
  answerCallbackQuery(text?: string): Promise<unknown>;
}

const buildKeyboard = (telegramId: number) => ({
  inline_keyboard: [[
    { text: 'Approve', callback_data: `approve:${telegramId}` },
    { text: 'Reject', callback_data: `reject:${telegramId}` },
  ]],
});

export function makeAdminModule(opts: AdminModuleOpts): AdminModule {
  return {
    async notifyAdminOfNewUser(input) {
      const handle = input.username ? `@${input.username}` : `id ${input.telegramId}`;
      const text =
        `New user request:\n` +
        `${handle} (id: ${input.telegramId})\n` +
        `email: ${input.email}`;
      await opts.api.sendMessage(opts.adminTelegramUserId, text, {
        reply_markup: buildKeyboard(input.telegramId),
      });
    },

    async handleCallback(ctx) {
      const cq = ctx.callbackQuery;
      if (!cq || !cq.data || !cq.message) return;
      if (!ctx.from || ctx.from.id !== opts.adminTelegramUserId) {
        logger.warn({ from: ctx.from?.id }, 'ignoring callback from non-admin');
        await ctx.answerCallbackQuery();
        return;
      }
      const [action, idStr] = cq.data.split(':');
      const telegramId = Number(idStr);
      if (!Number.isFinite(telegramId) || (action !== 'approve' && action !== 'reject')) return;

      const target = opts.repo.findById(telegramId);
      const handle = target?.username ? `@${target.username}` : `id ${telegramId}`;

      if (action === 'approve') {
        opts.repo.setStatus(telegramId, 'APPROVED');
        await opts.api.editMessageText(
          cq.message.chat.id,
          cq.message.message_id,
          `Approved ${handle} ✓`,
          {}
        );
        await opts.api.sendMessage(telegramId, "You're approved. Send away.");
      } else {
        opts.repo.setStatus(telegramId, 'REJECTED');
        await opts.api.editMessageText(
          cq.message.chat.id,
          cq.message.message_id,
          `Rejected ${handle} ✗`,
          {}
        );
        await opts.api.sendMessage(telegramId, 'Your request was declined.');
      }
      await ctx.answerCallbackQuery();
    },
  };
}
