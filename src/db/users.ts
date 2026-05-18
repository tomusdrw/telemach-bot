// src/db/users.ts
import type { DB } from './index';

export type UserStatus = 'PENDING_EMAIL' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

export interface User {
  telegramId: number;
  username: string | null;
  firstName: string | null;
  email: string | null;
  status: UserStatus;
  isAdmin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertNewInput {
  telegramId: number;
  username: string | null;
  firstName: string | null;
}

export interface AuditInput {
  telegramId: number;
  chatMessageId: number | null;
  event: 'received' | 'transcribed' | 'emailed' | 'error';
  details: string | null;
}

const now = () => Math.floor(Date.now() / 1000);

interface UserRow {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  email: string | null;
  status: UserStatus;
  is_admin: number;
  created_at: number;
  updated_at: number;
}

const rowToUser = (r: UserRow): User => ({
  telegramId: r.telegram_id,
  username: r.username,
  firstName: r.first_name,
  email: r.email,
  status: r.status,
  isAdmin: r.is_admin === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class UserRepo {
  constructor(private readonly db: DB) {}

  findById(telegramId: number): User | null {
    const row = this.db
      .prepare<[number], UserRow>(`SELECT * FROM users WHERE telegram_id = ?`)
      .get(telegramId);
    return row ? rowToUser(row) : null;
  }

  upsertNew(input: UpsertNewInput): void {
    const t = now();
    this.db
      .prepare(
        `INSERT INTO users (telegram_id, username, first_name, email, status, is_admin, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'PENDING_EMAIL', 0, ?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET
           username = excluded.username,
           first_name = excluded.first_name,
           updated_at = excluded.updated_at`
      )
      .run(input.telegramId, input.username, input.firstName, t, t);
  }

  setEmail(telegramId: number, email: string): void {
    const t = now();
    this.db
      .prepare(
        `UPDATE users
         SET email = ?, status = 'PENDING_APPROVAL', updated_at = ?
         WHERE telegram_id = ?`
      )
      .run(email, t, telegramId);
  }

  setStatus(telegramId: number, status: UserStatus): void {
    const t = now();
    this.db
      .prepare(`UPDATE users SET status = ?, updated_at = ? WHERE telegram_id = ?`)
      .run(status, t, telegramId);
  }

  seedAdmin(input: { telegramId: number; email: string }): void {
    const t = now();
    this.db
      .prepare(
        `INSERT INTO users (telegram_id, username, first_name, email, status, is_admin, created_at, updated_at)
         VALUES (?, NULL, NULL, ?, 'APPROVED', 1, ?, ?)
         ON CONFLICT(telegram_id) DO NOTHING`
      )
      .run(input.telegramId, input.email, t, t);
  }

  logAudit(input: AuditInput): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (telegram_id, chat_message_id, event, details, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.telegramId, input.chatMessageId, input.event, input.details, now());
  }
}
