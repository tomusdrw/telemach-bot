// tests/bot/timezone-cmd.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTimezoneCommand } from '../../src/bot/timezone-cmd.js';
import type { DB } from '../../src/db/index.js';
import { UserRepo } from '../../src/db/users.js';
import { makeTempDb } from '../helpers/temp-db.js';

function fakeCtx(from = { id: 7 }) {
  return {
    from,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe('/timezone command', () => {
  let db: DB;
  let repo: UserRepo;

  beforeEach(() => {
    db = makeTempDb();
    repo = new UserRepo(db);
    repo.upsertNew({ telegramId: 7, username: 'alice', firstName: 'Alice' });
    repo.setEmail(7, 'a@x.com');
    repo.setStatus(7, 'APPROVED');
  });

  it('no arg replies with current timezone', async () => {
    const ctx = fakeCtx();
    await handleTimezoneCommand(ctx as any, '', { repo });
    expect(ctx.reply).toHaveBeenCalledWith('Your timezone: Europe/Warsaw');
  });

  it('valid IANA arg updates DB and replies success', async () => {
    const ctx = fakeCtx();
    await handleTimezoneCommand(ctx as any, 'America/New_York', { repo });
    expect(repo.findById(7)?.timezone).toBe('America/New_York');
    expect(ctx.reply).toHaveBeenCalledWith('Timezone updated: America/New_York');
    const audit = db
      .prepare(`SELECT event, details FROM audit_log WHERE telegram_id = ? ORDER BY id`)
      .all(7) as { event: string; details: string }[];
    const tzRow = audit.find((r) => r.event === 'timezone_changed');
    expect(tzRow).toBeTruthy();
    expect(JSON.parse(tzRow!.details)).toEqual({ from: 'Europe/Warsaw', to: 'America/New_York' });
  });

  it('invalid IANA arg replies with hint, no DB write', async () => {
    const ctx = fakeCtx();
    await handleTimezoneCommand(ctx as any, 'Foo/Bar', { repo });
    expect(repo.findById(7)?.timezone).toBe('Europe/Warsaw');
    expect(ctx.reply).toHaveBeenCalledWith(
      "Unknown timezone. Use an IANA name like 'Europe/Warsaw' or 'America/New_York'.",
    );
  });

  it('non-approved user: no reply, no write', async () => {
    repo.setStatus(7, 'PENDING_APPROVAL');
    const ctx = fakeCtx();
    await handleTimezoneCommand(ctx as any, 'America/New_York', { repo });
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(repo.findById(7)?.timezone).toBe('Europe/Warsaw');
  });

  it('unknown user: no reply, no write', async () => {
    const ctx = fakeCtx({ id: 999 });
    await handleTimezoneCommand(ctx as any, 'America/New_York', { repo });
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('normalizes non-canonical IANA casing on store and in reply', async () => {
    const ctx = fakeCtx();
    await handleTimezoneCommand(ctx as any, 'europe/london', { repo });
    expect(repo.findById(7)?.timezone).toBe('Europe/London');
    expect(ctx.reply).toHaveBeenCalledWith('Timezone updated: Europe/London');
  });
});
