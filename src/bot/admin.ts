import type { Api } from 'grammy';
import type { UserRepo } from '../db/users.js';
import { logger } from '../lib/logger.js';

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
  handleUsersCommand(ctx: AdminCommandCtx): Promise<void>;
  handleRevokeCommand(ctx: AdminCommandCtx, arg: string): Promise<void>;
  handleResetCommand(ctx: AdminCommandCtx, arg: string): Promise<void>;
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

interface AdminCommandCtx {
  from?: { id: number };
  reply(text: string): Promise<unknown>;
}

const buildKeyboard = (telegramId: number) => ({
  inline_keyboard: [
    [
      { text: 'Approve', callback_data: `approve:${telegramId}` },
      { text: 'Reject', callback_data: `reject:${telegramId}` },
    ],
  ],
});

export function makeAdminModule(opts: AdminModuleOpts): AdminModule {
  return {
    async notifyAdminOfNewUser(input) {
      const handle = input.username ? `@${input.username}` : `id ${input.telegramId}`;
      const text = `New user request:\n${handle} (id: ${input.telegramId})\nemail: ${input.email}`;
      await opts.api.sendMessage(opts.adminTelegramUserId, text, {
        reply_markup: buildKeyboard(input.telegramId),
      });
    },

    async handleCallback(ctx) {
      const cq = ctx.callbackQuery;
      if (!cq?.data || !cq.message) return;
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

      // Guard against stale buttons: only act if the user is still pending.
      // Earlier admin DMs may still have live keyboards after a newer decision.
      if (!target || target.status !== 'PENDING_APPROVAL') {
        await opts.api.editMessageText(
          cq.message.chat.id,
          cq.message.message_id,
          `${handle} already decided (${target?.status ?? 'unknown'}).`,
          {},
        );
        await ctx.answerCallbackQuery('Already decided');
        return;
      }

      if (action === 'approve') {
        opts.repo.setStatus(telegramId, 'APPROVED');
        await opts.api.editMessageText(cq.message.chat.id, cq.message.message_id, `Approved ${handle} ✓`, {});
        await opts.api.sendMessage(telegramId, "You're approved. Send away.");
      } else {
        opts.repo.setStatus(telegramId, 'REJECTED');
        await opts.api.editMessageText(cq.message.chat.id, cq.message.message_id, `Rejected ${handle} ✗`, {});
        await opts.api.sendMessage(telegramId, 'Your request was declined.');
      }
      await ctx.answerCallbackQuery();
    },

    async handleUsersCommand(ctx) {
      if (!isAdmin(ctx, opts.adminTelegramUserId)) return;
      const users = opts.repo.listUsers({ limit: 50 });
      if (users.length === 0) {
        await ctx.reply('No users yet.');
        return;
      }
      const lines = users.map((u) => {
        const handle = u.username ? `@${u.username}` : `id ${u.telegramId}`;
        const email = u.email ?? '(no email)';
        const admin = u.isAdmin ? ' [admin]' : '';
        return `${handle} (${u.telegramId}) — ${u.status} — ${email}${admin}`;
      });
      await ctx.reply(`Users (${users.length}):\n${lines.join('\n')}`);
    },

    async handleRevokeCommand(ctx, arg) {
      if (!isAdmin(ctx, opts.adminTelegramUserId)) return;
      const telegramId = Number(arg.trim());
      if (!Number.isFinite(telegramId) || telegramId <= 0) {
        await ctx.reply('Usage: /revoke <telegram_id>');
        return;
      }
      const user = opts.repo.findById(telegramId);
      if (!user) {
        await ctx.reply(`No user with id ${telegramId}.`);
        return;
      }
      if (user.isAdmin) {
        await ctx.reply(`Refusing to revoke admin (${telegramId}).`);
        return;
      }
      if (user.status !== 'APPROVED') {
        await ctx.reply(`User ${telegramId} is ${user.status}, not APPROVED. No change.`);
        return;
      }
      opts.repo.setStatus(telegramId, 'REJECTED');
      const handle = user.username ? `@${user.username}` : `id ${telegramId}`;
      await ctx.reply(`Revoked ${handle}. They will no longer be forwarded.`);
    },

    async handleResetCommand(ctx, arg) {
      if (!isAdmin(ctx, opts.adminTelegramUserId)) return;
      const telegramId = Number(arg.trim());
      if (!Number.isFinite(telegramId) || telegramId <= 0) {
        await ctx.reply('Usage: /reset <telegram_id>');
        return;
      }
      const user = opts.repo.findById(telegramId);
      if (!user) {
        await ctx.reply(`No user with id ${telegramId}.`);
        return;
      }
      if (user.isAdmin) {
        await ctx.reply(`Refusing to reset admin (${telegramId}).`);
        return;
      }
      opts.repo.resetUser(telegramId);
      const handle = user.username ? `@${user.username}` : `id ${telegramId}`;
      await ctx.reply(`Reset ${handle}. Email cleared; status now PENDING_EMAIL.`);
    },
  };
}

function isAdmin(ctx: { from?: { id: number } }, adminId: number): boolean {
  if (!ctx.from || ctx.from.id !== adminId) {
    logger.warn({ from: ctx.from?.id }, 'ignoring admin command from non-admin');
    return false;
  }
  return true;
}
