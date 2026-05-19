// tests/db/users.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/db/index.js';
import { UserRepo, type UserStatus } from '../../src/db/users.js';
import { makeTempDb } from '../helpers/temp-db.js';

describe('UserRepo', () => {
  let db: DB;
  let repo: UserRepo;

  beforeEach(() => {
    db = makeTempDb();
    repo = new UserRepo(db);
  });

  it('returns null for unknown user', () => {
    expect(repo.findById(42)).toBeNull();
  });

  it('upserts a user (insert path)', () => {
    repo.upsertNew({ telegramId: 1, username: 'a', firstName: 'A' });
    const u = repo.findById(1);
    expect(u?.status).toBe<UserStatus>('PENDING_EMAIL');
    expect(u?.username).toBe('a');
    expect(u?.isAdmin).toBe(false);
  });

  it('upsertNew is idempotent (does not reset status)', () => {
    repo.upsertNew({ telegramId: 1, username: 'a', firstName: 'A' });
    repo.setStatus(1, 'APPROVED');
    repo.upsertNew({ telegramId: 1, username: 'a', firstName: 'A' });
    expect(repo.findById(1)?.status).toBe<UserStatus>('APPROVED');
  });

  it('setEmail moves PENDING_EMAIL to PENDING_APPROVAL', () => {
    repo.upsertNew({ telegramId: 1, username: 'a', firstName: 'A' });
    repo.setEmail(1, 'x@y.com');
    const u = repo.findById(1)!;
    expect(u.email).toBe('x@y.com');
    expect(u.status).toBe<UserStatus>('PENDING_APPROVAL');
  });

  it('setStatus changes status', () => {
    repo.upsertNew({ telegramId: 1, username: 'a', firstName: 'A' });
    repo.setStatus(1, 'REJECTED');
    expect(repo.findById(1)?.status).toBe<UserStatus>('REJECTED');
  });

  it('seedAdmin inserts an APPROVED admin if missing', () => {
    repo.seedAdmin({ telegramId: 99, email: 'admin@x.com' });
    const u = repo.findById(99)!;
    expect(u.status).toBe<UserStatus>('APPROVED');
    expect(u.isAdmin).toBe(true);
    expect(u.email).toBe('admin@x.com');
  });

  it('seedAdmin is a no-op if the admin row already exists', () => {
    repo.seedAdmin({ telegramId: 99, email: 'admin@x.com' });
    repo.setStatus(99, 'REJECTED'); // contrived but tests idempotency
    repo.seedAdmin({ telegramId: 99, email: 'other@x.com' });
    expect(repo.findById(99)?.email).toBe('admin@x.com');
    expect(repo.findById(99)?.status).toBe<UserStatus>('REJECTED');
  });

  it('logAudit appends a row', () => {
    repo.upsertNew({ telegramId: 1, username: 'a', firstName: 'A' });
    repo.logAudit({ telegramId: 1, chatMessageId: 10, event: 'received', details: '{}' });
    repo.logAudit({ telegramId: 1, chatMessageId: 11, event: 'emailed', details: null });
    const rows = db.prepare(`SELECT event FROM audit_log WHERE telegram_id = ? ORDER BY id`).all(1);
    expect(rows.map((r: any) => r.event)).toEqual(['received', 'emailed']);
  });

  it('defaults timezone to Europe/Warsaw on insert', () => {
    repo.upsertNew({ telegramId: 1, username: 'a', firstName: 'A' });
    expect(repo.findById(1)?.timezone).toBe('Europe/Warsaw');
  });

  it('updateTimezone changes the timezone', () => {
    repo.upsertNew({ telegramId: 1, username: 'a', firstName: 'A' });
    repo.updateTimezone(1, 'America/New_York');
    expect(repo.findById(1)?.timezone).toBe('America/New_York');
  });

  it('seedAdmin row has default timezone Europe/Warsaw', () => {
    repo.seedAdmin({ telegramId: 99, email: 'admin@x.com' });
    expect(repo.findById(99)?.timezone).toBe('Europe/Warsaw');
  });
});
