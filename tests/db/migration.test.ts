// tests/db/migration.test.ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureUsersTimezoneColumn } from '../../src/db/index.js';
import { UserRepo } from '../../src/db/users.js';

const LEGACY_USERS_DDL = `
CREATE TABLE users (
  telegram_id   INTEGER PRIMARY KEY,
  username      TEXT,
  first_name    TEXT,
  email         TEXT,
  status        TEXT NOT NULL
                 CHECK (status IN ('PENDING_EMAIL','PENDING_APPROVAL','APPROVED','REJECTED')),
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
`;

describe('ensureUsersTimezoneColumn', () => {
  it('adds timezone column with default to a legacy users table', () => {
    const db = new Database(':memory:');
    db.exec(LEGACY_USERS_DDL);
    ensureUsersTimezoneColumn(db);
    const cols = db.prepare(`PRAGMA table_info('users')`).all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('timezone');

    // A row inserted after migration picks up the default.
    const repo = new UserRepo(db);
    repo.upsertNew({ telegramId: 1, username: 'a', firstName: 'A' });
    expect(repo.findById(1)?.timezone).toBe('Europe/Warsaw');
  });

  it('is idempotent (running it twice does not throw)', () => {
    const db = new Database(':memory:');
    db.exec(LEGACY_USERS_DDL);
    ensureUsersTimezoneColumn(db);
    expect(() => ensureUsersTimezoneColumn(db)).not.toThrow();
    const cols = db.prepare(`PRAGMA table_info('users')`).all() as { name: string }[];
    expect(cols.filter((c) => c.name === 'timezone').length).toBe(1);
  });

  it('is a no-op when timezone column already exists', () => {
    const db = new Database(':memory:');
    db.exec(
      LEGACY_USERS_DDL.replace(
        'updated_at    INTEGER NOT NULL\n);',
        `updated_at    INTEGER NOT NULL,\n  timezone      TEXT NOT NULL DEFAULT 'Europe/Warsaw'\n);`,
      ),
    );
    expect(() => ensureUsersTimezoneColumn(db)).not.toThrow();
  });
});
