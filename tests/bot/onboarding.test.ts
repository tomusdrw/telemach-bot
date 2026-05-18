// tests/bot/onboarding.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleStart, handleRegister, handlePlainMessage } from '../../src/bot/onboarding';
import { UserRepo } from '../../src/db/users';
import { makeTempDb } from '../helpers/temp-db';

function makeCtx(opts: { from?: { id: number; username?: string; first_name?: string } } = {}) {
  return {
    from: opts.from ?? { id: 7, username: 'u', first_name: 'F' },
    reply: vi.fn().mockResolvedValue(undefined),
    react: vi.fn().mockResolvedValue(undefined),
  };
}

describe('onboarding handlers', () => {
  let repo: UserRepo;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    repo = new UserRepo(makeTempDb());
    notify = vi.fn().mockResolvedValue(undefined);
  });

  it('/start on unknown user creates row and greets', async () => {
    const ctx = makeCtx();
    await handleStart(ctx as any, { repo, notify });
    expect(repo.findById(7)?.status).toBe('PENDING_EMAIL');
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringMatching(/\/register your@email\.com/i)
    );
  });

  it('/start on approved user replies "already set up"', async () => {
    repo.upsertNew({ telegramId: 7, username: 'u', firstName: 'F' });
    repo.setStatus(7, 'APPROVED');
    const ctx = makeCtx();
    await handleStart(ctx as any, { repo, notify });
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/already set up/i));
  });

  it('/register accepts a valid email and notifies admin', async () => {
    repo.upsertNew({ telegramId: 7, username: 'u', firstName: 'F' });
    const ctx = makeCtx();
    await handleRegister(ctx as any, { repo, notify, emailArg: 'me@example.com' });
    expect(repo.findById(7)?.email).toBe('me@example.com');
    expect(repo.findById(7)?.status).toBe('PENDING_APPROVAL');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      telegramId: 7, username: 'u', email: 'me@example.com',
    }));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/waiting for admin/i));
  });

  it('/register rejects malformed email', async () => {
    repo.upsertNew({ telegramId: 7, username: 'u', firstName: 'F' });
    const ctx = makeCtx();
    await handleRegister(ctx as any, { repo, notify, emailArg: 'not-an-email' });
    expect(repo.findById(7)?.email).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/not a valid email/i));
  });

  it('/register with empty argument tells the user to provide one', async () => {
    repo.upsertNew({ telegramId: 7, username: 'u', firstName: 'F' });
    const ctx = makeCtx();
    await handleRegister(ctx as any, { repo, notify, emailArg: '' });
    expect(repo.findById(7)?.email).toBeNull();
    expect(repo.findById(7)?.status).toBe('PENDING_EMAIL');
    expect(notify).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/not a valid email/i));
  });

  it('/register from approved user replies "cannot be changed"', async () => {
    repo.upsertNew({ telegramId: 7, username: 'u', firstName: 'F' });
    repo.setEmail(7, 'old@x.com');
    repo.setStatus(7, 'APPROVED');
    const ctx = makeCtx();
    await handleRegister(ctx as any, { repo, notify, emailArg: 'new@x.com' });
    expect(repo.findById(7)?.email).toBe('old@x.com');
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/cannot be changed/i));
  });

  it('plain message from PENDING_EMAIL nags once', async () => {
    repo.upsertNew({ telegramId: 7, username: 'u', firstName: 'F' });
    const ctx = makeCtx();
    const handled = await handlePlainMessage(ctx as any, { repo, notify });
    expect(handled).toEqual({ forwardToApprovedFlow: false });
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/Please run \/register/));
  });

  it('plain message from APPROVED returns "go to forward flow"', async () => {
    repo.upsertNew({ telegramId: 7, username: 'u', firstName: 'F' });
    repo.setStatus(7, 'APPROVED');
    const ctx = makeCtx();
    const handled = await handlePlainMessage(ctx as any, { repo, notify });
    expect(handled).toEqual({ forwardToApprovedFlow: true });
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('plain message from unknown user is ignored (no reply)', async () => {
    const ctx = makeCtx();
    const handled = await handlePlainMessage(ctx as any, { repo, notify });
    expect(handled).toEqual({ forwardToApprovedFlow: false });
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
