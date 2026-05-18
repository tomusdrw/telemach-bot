import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeAdminModule } from '../../src/bot/admin';
import { UserRepo } from '../../src/db/users';
import { makeTempDb } from '../helpers/temp-db';

function fakeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  };
}

describe('admin module', () => {
  let repo: UserRepo;

  beforeEach(() => {
    repo = new UserRepo(makeTempDb());
    repo.seedAdmin({ telegramId: 1, email: 'admin@x.com' });
  });

  it('notifyAdminOfNewUser sends a DM with approve/reject buttons', async () => {
    const api = fakeApi();
    const mod = makeAdminModule({ api: api as any, adminTelegramUserId: 1, repo });
    await mod.notifyAdminOfNewUser({
      telegramId: 9,
      username: 'bob',
      firstName: 'Bob',
      email: 'bob@x.com',
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(1);
    expect(text).toContain('bob@x.com');
    expect(text).toContain('@bob');
    expect(opts.reply_markup.inline_keyboard).toBeDefined();
    const buttons = opts.reply_markup.inline_keyboard.flat();
    expect(buttons.map((b: any) => b.callback_data)).toEqual(['approve:9', 'reject:9']);
  });

  it('handleApprove sets user APPROVED, edits message, and DMs the user', async () => {
    repo.upsertNew({ telegramId: 9, username: 'bob', firstName: 'Bob' });
    repo.setEmail(9, 'bob@x.com');
    const api = fakeApi();
    const mod = makeAdminModule({ api: api as any, adminTelegramUserId: 1, repo });
    const ctx = {
      from: { id: 1 },
      callbackQuery: { id: 'cb', data: 'approve:9', message: { message_id: 5, chat: { id: 1 } } },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };
    await mod.handleCallback(ctx as any);
    expect(repo.findById(9)?.status).toBe('APPROVED');
    expect(api.editMessageText).toHaveBeenCalledWith(
      1, 5, expect.stringMatching(/Approved @bob/i), expect.any(Object)
    );
    expect(api.sendMessage).toHaveBeenCalledWith(9, expect.stringMatching(/approved/i));
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('handleReject sets user REJECTED, edits, and DMs', async () => {
    repo.upsertNew({ telegramId: 9, username: 'bob', firstName: 'Bob' });
    repo.setEmail(9, 'bob@x.com');
    const api = fakeApi();
    const mod = makeAdminModule({ api: api as any, adminTelegramUserId: 1, repo });
    const ctx = {
      from: { id: 1 },
      callbackQuery: { id: 'cb', data: 'reject:9', message: { message_id: 5, chat: { id: 1 } } },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };
    await mod.handleCallback(ctx as any);
    expect(repo.findById(9)?.status).toBe('REJECTED');
    expect(api.editMessageText).toHaveBeenCalledWith(
      1, 5, expect.stringMatching(/Rejected @bob/i), expect.any(Object)
    );
    expect(api.sendMessage).toHaveBeenCalledWith(9, expect.stringMatching(/declined/i));
  });

  it('ignores callbacks from non-admin', async () => {
    repo.upsertNew({ telegramId: 9, username: 'bob', firstName: 'Bob' });
    const api = fakeApi();
    const mod = makeAdminModule({ api: api as any, adminTelegramUserId: 1, repo });
    const ctx = {
      from: { id: 9 },                                  // not the admin
      callbackQuery: { id: 'cb', data: 'approve:9', message: { message_id: 5, chat: { id: 9 } } },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };
    await mod.handleCallback(ctx as any);
    // user status should NOT have changed (still PENDING_EMAIL from upsertNew)
    expect(repo.findById(9)?.status).toBe('PENDING_EMAIL');
    expect(api.editMessageText).not.toHaveBeenCalled();
  });
});
