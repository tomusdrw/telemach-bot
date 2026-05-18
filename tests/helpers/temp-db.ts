// tests/helpers/temp-db.ts

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from '../../src/db/index';

const SCHEMA_PATH = resolve(__dirname, '..', '..', 'src', 'db', 'schema.sql');

export function makeTempDb(): DB {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  return db;
}
