// tests/helpers/temp-db.ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DB } from '../../src/db/index';

export function makeTempDb(): DB {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  const schema = readFileSync(resolve('src/db/schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}
