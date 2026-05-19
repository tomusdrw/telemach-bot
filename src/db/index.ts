// src/db/index.ts

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

export function openDatabase(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  ensureUsersTimezoneColumn(db);
  return db;
}

interface ColInfo {
  name: string;
}

function ensureUsersTimezoneColumn(db: DB): void {
  const cols = db.prepare<[], ColInfo>(`PRAGMA table_info('users')`).all();
  if (cols.some((c) => c.name === 'timezone')) return;
  db.exec(`ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw'`);
}
