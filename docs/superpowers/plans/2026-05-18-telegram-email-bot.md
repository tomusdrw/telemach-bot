# Telegram → Email Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Telegram bot that forwards messages, attachments, and transcribed voice notes to a per-user email via Resend, using OpenRouter to generate the subject and reactions (not chat replies) for status. Multi-user with admin approval. Ships as one Docker container with a mounted `/data` volume.

**Architecture:** Single Node.js/TypeScript process. grammy long-polls Telegram. SQLite (`better-sqlite3`) for user/audit state. OpenAI Whisper for transcription. OpenRouter for subject generation. Resend for email. Pure helpers (auth predicates, media-group buffer, email composer, subject prompt) are isolated and unit-tested with vitest; service wrappers are mocked at SDK boundary; one integration-ish test for the main forward handler.

**Tech Stack:** Node 22 + TypeScript (strict) · grammy · better-sqlite3 · openai · resend · pino · zod · vitest · Docker (two-stage, non-root).

**Spec:** `docs/superpowers/specs/2026-05-18-telegram-email-bot-design.md`

---

## File Structure

```
.
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                 # entry: load config, init db, start bot
│   ├── config.ts                # zod env parsing
│   ├── lib/
│   │   ├── errors.ts            # TransientError, FatalError, withRetry
│   │   └── logger.ts            # pino instance
│   ├── db/
│   │   ├── schema.sql           # SQLite schema (CREATE IF NOT EXISTS)
│   │   ├── index.ts             # connection + schema bootstrap + admin seed
│   │   └── users.ts             # user repository
│   ├── services/
│   │   ├── telegram-files.ts    # download file_id → Buffer, size guard
│   │   ├── whisper.ts           # OpenAI Whisper wrapper
│   │   ├── subject.ts           # OpenRouter wrapper (single attempt, fallback)
│   │   └── resend.ts            # Resend wrapper
│   └── bot/
│       ├── index.ts             # grammy Bot setup + handler wiring
│       ├── auth.ts              # auth predicates + middleware
│       ├── reactions.ts         # 👀 → ✍ → 👍/💩 helpers
│       ├── media-group.ts       # in-memory buffer with flush timer
│       ├── email-composer.ts    # pure: build Resend payload from messages
│       ├── subject-prompt.ts    # pure: build OpenRouter prompt
│       ├── onboarding.ts        # /start, /register handlers
│       ├── admin.ts             # approve/reject callback handlers + DM
│       └── forward.ts           # main forward handler (calls all services)
└── tests/
    ├── helpers/
    │   ├── temp-db.ts           # in-memory SQLite for tests
    │   └── fake-ctx.ts          # minimal grammy Context stub
    ├── lib/errors.test.ts
    ├── db/users.test.ts
    ├── bot/auth.test.ts
    ├── bot/reactions.test.ts
    ├── bot/media-group.test.ts
    ├── bot/email-composer.test.ts
    ├── bot/subject-prompt.test.ts
    ├── bot/onboarding.test.ts
    ├── bot/admin.test.ts
    ├── bot/forward.test.ts
    ├── services/telegram-files.test.ts
    ├── services/whisper.test.ts
    ├── services/subject.test.ts
    └── services/resend.test.ts
```

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "telemach-bot",
  "version": "0.1.0",
  "private": true,
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "dotenv": "^16.4.5",
    "grammy": "^1.30.0",
    "openai": "^4.68.0",
    "pino": "^9.4.0",
    "resend": "^3.5.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.7.0",
    "tsx": "^4.19.1",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noImplicitAny": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

> Note: `resend` v4 is ESM-only. With `esModuleInterop: true` and `module: "CommonJS"`, TypeScript compiles `import { Resend } from 'resend'` correctly, but Node's CommonJS loader cannot `require()` an ESM-only package at runtime. If `npm test` or `npm start` errors with `ERR_REQUIRE_ESM`, downgrade to `resend@^3` (CJS-compatible) or pin `resend@^4` and switch project to ESM later. Resend v3 has the same `emails.send` API used in this plan.

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    pool: 'forks',
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
.env
.env.local
data/
*.db
*.db-journal
*.log
coverage/
.vitest/
```

- [ ] **Step 5: Create `.env.example`**

```
# Telegram
TELEGRAM_BOT_TOKEN=
ADMIN_TELEGRAM_USER_ID=
ADMIN_EMAIL=

# OpenAI (Whisper)
OPENAI_API_KEY=

# OpenRouter (subject generation)
OPENROUTER_API_KEY=
OPENROUTER_MODEL=google/gemini-flash-1.5

# Resend
RESEND_API_KEY=
RESEND_FROM_EMAIL=

# Storage
DB_PATH=./data/bot.db

# Behavior
LOG_LEVEL=info
MEDIA_GROUP_FLUSH_MS=2000
```

- [ ] **Step 6: Install deps**

Run: `npm install`
Expected: `node_modules/` populated, `package-lock.json` created, no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example
git commit -m "chore: scaffold TypeScript project with grammy, vitest, and core deps"
```

---

### Task 2: Errors module

**Files:**
- Create: `src/lib/errors.ts`
- Test: `tests/lib/errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/errors.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TransientError, FatalError, withRetry } from '../../src/lib/errors';

describe('errors', () => {
  it('TransientError and FatalError are distinct named classes', () => {
    const t = new TransientError('boom', { provider: 'whisper' });
    const f = new FatalError('nope', { provider: 'resend' });
    expect(t).toBeInstanceOf(TransientError);
    expect(t.name).toBe('TransientError');
    expect(t.provider).toBe('whisper');
    expect(f).toBeInstanceOf(FatalError);
    expect(f.name).toBe('FatalError');
    expect(f.provider).toBe('resend');
  });

  it('withRetry returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn, { delaysMs: [10, 20, 40] });
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('withRetry retries TransientError up to delays.length+1 times', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new TransientError('1', { provider: 'x' }))
      .mockRejectedValueOnce(new TransientError('2', { provider: 'x' }))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { delaysMs: [1, 1, 1] });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('withRetry does NOT retry FatalError', async () => {
    const fn = vi.fn().mockRejectedValue(new FatalError('bad', { provider: 'x' }));
    await expect(withRetry(fn, { delaysMs: [1, 1, 1] })).rejects.toBeInstanceOf(FatalError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('withRetry exhausts retries and rethrows', async () => {
    const err = new TransientError('still bad', { provider: 'x' });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { delaysMs: [1, 1] })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/lib/errors.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/errors.ts`**

```ts
// src/lib/errors.ts
export interface ErrorContext {
  provider: 'whisper' | 'openrouter' | 'resend' | 'telegram' | 'db';
  detail?: unknown;
}

export class TransientError extends Error {
  readonly provider: ErrorContext['provider'];
  readonly detail: unknown;
  constructor(message: string, ctx: ErrorContext) {
    super(message);
    this.name = 'TransientError';
    this.provider = ctx.provider;
    this.detail = ctx.detail;
  }
}

export class FatalError extends Error {
  readonly provider: ErrorContext['provider'];
  readonly detail: unknown;
  constructor(message: string, ctx: ErrorContext) {
    super(message);
    this.name = 'FatalError';
    this.provider = ctx.provider;
    this.detail = ctx.detail;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RetryOptions {
  delaysMs: number[]; // e.g. [500, 2000, 8000]
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof TransientError) || attempt >= opts.delaysMs.length) {
        throw err;
      }
      await sleep(opts.delaysMs[attempt]!);
      attempt += 1;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/lib/errors.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/errors.ts tests/lib/errors.test.ts
git commit -m "feat(lib): add TransientError/FatalError with withRetry helper"
```

---

### Task 3: Logger

**Files:**
- Create: `src/lib/logger.ts`

This module is a thin pino instance with no logic worth unit-testing.

- [ ] **Step 1: Implement `src/lib/logger.ts`**

```ts
// src/lib/logger.ts
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  base: { service: 'telemach-bot' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/logger.ts
git commit -m "feat(lib): add pino logger"
```

---

### Task 4: Config (zod env parsing)

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/config.test.ts
import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config';

const baseEnv = {
  TELEGRAM_BOT_TOKEN: 'token',
  ADMIN_TELEGRAM_USER_ID: '12345',
  ADMIN_EMAIL: 'admin@example.com',
  OPENAI_API_KEY: 'sk-x',
  OPENROUTER_API_KEY: 'or-x',
  RESEND_API_KEY: 're-x',
  RESEND_FROM_EMAIL: 'bot@example.com',
};

describe('parseConfig', () => {
  it('parses a valid env and applies defaults', () => {
    const cfg = parseConfig(baseEnv);
    expect(cfg.telegramBotToken).toBe('token');
    expect(cfg.adminTelegramUserId).toBe(12345);
    expect(cfg.adminEmail).toBe('admin@example.com');
    expect(cfg.openrouterModel).toBe('google/gemini-flash-1.5');
    expect(cfg.dbPath).toBe('./data/bot.db');
    expect(cfg.mediaGroupFlushMs).toBe(2000);
    expect(cfg.logLevel).toBe('info');
  });

  it('throws when a required var is missing', () => {
    const { TELEGRAM_BOT_TOKEN, ...rest } = baseEnv;
    expect(() => parseConfig(rest)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('throws when ADMIN_TELEGRAM_USER_ID is not numeric', () => {
    expect(() => parseConfig({ ...baseEnv, ADMIN_TELEGRAM_USER_ID: 'abc' }))
      .toThrow(/ADMIN_TELEGRAM_USER_ID/);
  });

  it('throws when ADMIN_EMAIL is not an email', () => {
    expect(() => parseConfig({ ...baseEnv, ADMIN_EMAIL: 'notanemail' }))
      .toThrow(/ADMIN_EMAIL/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/config.ts`**

```ts
// src/config.ts
import { z } from 'zod';

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ADMIN_TELEGRAM_USER_ID: z.string().regex(/^\d+$/, 'must be numeric'),
  ADMIN_EMAIL: z.string().email(),

  OPENAI_API_KEY: z.string().min(1),

  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().default('google/gemini-flash-1.5'),

  RESEND_API_KEY: z.string().min(1),
  RESEND_FROM_EMAIL: z.string().email(),

  DB_PATH: z.string().default('./data/bot.db'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MEDIA_GROUP_FLUSH_MS: z.string().regex(/^\d+$/).default('2000'),
});

export interface Config {
  telegramBotToken: string;
  adminTelegramUserId: number;
  adminEmail: string;
  openaiApiKey: string;
  openrouterApiKey: string;
  openrouterModel: string;
  resendApiKey: string;
  resendFromEmail: string;
  dbPath: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  mediaGroupFlushMs: number;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  return {
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    adminTelegramUserId: Number(e.ADMIN_TELEGRAM_USER_ID),
    adminEmail: e.ADMIN_EMAIL,
    openaiApiKey: e.OPENAI_API_KEY,
    openrouterApiKey: e.OPENROUTER_API_KEY,
    openrouterModel: e.OPENROUTER_MODEL,
    resendApiKey: e.RESEND_API_KEY,
    resendFromEmail: e.RESEND_FROM_EMAIL,
    dbPath: e.DB_PATH,
    logLevel: e.LOG_LEVEL,
    mediaGroupFlushMs: Number(e.MEDIA_GROUP_FLUSH_MS),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/config.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add zod-validated config loader"
```

---

### Task 5: Database schema + connection

**Files:**
- Create: `src/db/schema.sql`
- Create: `src/db/index.ts`
- Create: `tests/helpers/temp-db.ts`

This is foundational; tested implicitly via the users repo in the next task.

- [ ] **Step 1: Create `src/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS users (
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

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id     INTEGER NOT NULL,
  chat_message_id INTEGER,
  event           TEXT NOT NULL,
  details         TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_user_time
  ON audit_log (telegram_id, created_at DESC);
```

- [ ] **Step 2: Implement `src/db/index.ts`**

```ts
// src/db/index.ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDatabase(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}
```

- [ ] **Step 3: Create test helper `tests/helpers/temp-db.ts`**

```ts
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
```

- [ ] **Step 4: Configure schema.sql to be copied to dist on build**

Edit `tsconfig.json` is not enough since tsc doesn't copy `.sql`. Update `package.json` `build` script:

Replace the `build` line with:

```json
    "build": "tsc -p tsconfig.json && mkdir -p dist/db && cp src/db/schema.sql dist/db/schema.sql",
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/index.ts tests/helpers/temp-db.ts package.json
git commit -m "feat(db): SQLite schema and connection helper"
```

---

### Task 6: Users repository

**Files:**
- Create: `src/db/users.ts`
- Test: `tests/db/users.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/users.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTempDb } from '../helpers/temp-db';
import { UserRepo, type UserStatus } from '../../src/db/users';
import type { DB } from '../../src/db/index';

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/db/users.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/db/users.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/db/users.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/db/users.ts tests/db/users.test.ts
git commit -m "feat(db): UserRepo with upsert, status transitions, and audit log"
```

---

### Task 7: Auth predicates

**Files:**
- Create: `src/bot/auth.ts`
- Test: `tests/bot/auth.test.ts`

This task implements only the **pure predicates**. The actual grammy middleware wiring happens in Task 17.

- [ ] **Step 1: Write the failing test**

```ts
// tests/bot/auth.test.ts
import { describe, it, expect } from 'vitest';
import { decideAction, type UserView } from '../../src/bot/auth';
import type { UserStatus } from '../../src/db/users';

const mkUser = (status: UserStatus | null): UserView | null =>
  status === null ? null : { telegramId: 1, status, isAdmin: false };

describe('decideAction', () => {
  it('unknown user + /start → create+greet', () => {
    expect(decideAction(mkUser(null), { kind: 'start' })).toEqual({ type: 'create-and-greet' });
  });

  it('unknown user + /register foo → create+register', () => {
    expect(decideAction(mkUser(null), { kind: 'register', email: 'a@b.com' }))
      .toEqual({ type: 'create-and-register', email: 'a@b.com' });
  });

  it('unknown user + plain message → ignore', () => {
    expect(decideAction(mkUser(null), { kind: 'message' })).toEqual({ type: 'ignore' });
  });

  it('PENDING_EMAIL + plain message → nag once', () => {
    expect(decideAction(mkUser('PENDING_EMAIL'), { kind: 'message' }))
      .toEqual({ type: 'nag-register' });
  });

  it('PENDING_EMAIL + /register → register', () => {
    expect(decideAction(mkUser('PENDING_EMAIL'), { kind: 'register', email: 'a@b.com' }))
      .toEqual({ type: 'register', email: 'a@b.com' });
  });

  it('PENDING_APPROVAL + plain message → ignore', () => {
    expect(decideAction(mkUser('PENDING_APPROVAL'), { kind: 'message' }))
      .toEqual({ type: 'ignore' });
  });

  it('PENDING_APPROVAL + /register → reregister (replace email)', () => {
    expect(decideAction(mkUser('PENDING_APPROVAL'), { kind: 'register', email: 'a@b.com' }))
      .toEqual({ type: 'register', email: 'a@b.com' });
  });

  it('REJECTED + anything → ignore', () => {
    expect(decideAction(mkUser('REJECTED'), { kind: 'message' }))
      .toEqual({ type: 'ignore' });
    expect(decideAction(mkUser('REJECTED'), { kind: 'register', email: 'a@b.com' }))
      .toEqual({ type: 'ignore' });
    expect(decideAction(mkUser('REJECTED'), { kind: 'start' }))
      .toEqual({ type: 'ignore' });
  });

  it('APPROVED + plain message → forward', () => {
    expect(decideAction(mkUser('APPROVED'), { kind: 'message' }))
      .toEqual({ type: 'forward' });
  });

  it('APPROVED + /start → already-set-up', () => {
    expect(decideAction(mkUser('APPROVED'), { kind: 'start' }))
      .toEqual({ type: 'already-set-up' });
  });

  it('APPROVED + /register → cannot-change-email', () => {
    expect(decideAction(mkUser('APPROVED'), { kind: 'register', email: 'a@b.com' }))
      .toEqual({ type: 'cannot-change-email' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/bot/auth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/bot/auth.ts`**

```ts
// src/bot/auth.ts
import type { UserStatus } from '../db/users';

export interface UserView {
  telegramId: number;
  status: UserStatus;
  isAdmin: boolean;
}

export type Input =
  | { kind: 'start' }
  | { kind: 'register'; email: string }
  | { kind: 'message' };

export type Action =
  | { type: 'create-and-greet' }
  | { type: 'create-and-register'; email: string }
  | { type: 'register'; email: string }
  | { type: 'nag-register' }
  | { type: 'forward' }
  | { type: 'already-set-up' }
  | { type: 'cannot-change-email' }
  | { type: 'ignore' };

export function decideAction(user: UserView | null, input: Input): Action {
  if (user === null) {
    if (input.kind === 'start') return { type: 'create-and-greet' };
    if (input.kind === 'register') return { type: 'create-and-register', email: input.email };
    return { type: 'ignore' };
  }
  if (user.status === 'REJECTED') return { type: 'ignore' };
  if (user.status === 'PENDING_EMAIL') {
    if (input.kind === 'register') return { type: 'register', email: input.email };
    if (input.kind === 'message') return { type: 'nag-register' };
    return { type: 'ignore' }; // /start on existing PENDING_EMAIL: no-op
  }
  if (user.status === 'PENDING_APPROVAL') {
    if (input.kind === 'register') return { type: 'register', email: input.email };
    return { type: 'ignore' };
  }
  // APPROVED
  if (input.kind === 'message') return { type: 'forward' };
  if (input.kind === 'start') return { type: 'already-set-up' };
  return { type: 'cannot-change-email' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/bot/auth.test.ts`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add src/bot/auth.ts tests/bot/auth.test.ts
git commit -m "feat(bot): pure auth decision function"
```

---

### Task 8: Reactions helper

**Files:**
- Create: `src/bot/reactions.ts`
- Test: `tests/bot/reactions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/bot/reactions.test.ts
import { describe, it, expect, vi } from 'vitest';
import { markReceived, markWorking, markDone, markFailed } from '../../src/bot/reactions';

function fakeCtx() {
  const react = vi.fn().mockResolvedValue(undefined);
  return { react, _react: react };
}

describe('reactions', () => {
  it('markReceived sets 👀', async () => {
    const ctx = fakeCtx();
    await markReceived(ctx as any);
    expect(ctx._react).toHaveBeenCalledWith('👀');
  });

  it('markWorking sets ✍', async () => {
    const ctx = fakeCtx();
    await markWorking(ctx as any);
    expect(ctx._react).toHaveBeenCalledWith('✍');
  });

  it('markDone sets 👍', async () => {
    const ctx = fakeCtx();
    await markDone(ctx as any);
    expect(ctx._react).toHaveBeenCalledWith('👍');
  });

  it('markFailed sets 💩', async () => {
    const ctx = fakeCtx();
    await markFailed(ctx as any);
    expect(ctx._react).toHaveBeenCalledWith('💩');
  });

  it('swallows errors from react() and does not throw', async () => {
    const ctx = { react: vi.fn().mockRejectedValue(new Error('msg deleted')) };
    await expect(markDone(ctx as any)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/bot/reactions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/bot/reactions.ts`**

```ts
// src/bot/reactions.ts
import { logger } from '../lib/logger';

export interface ReactCtx {
  react(emoji: string): Promise<unknown>;
}

async function safeReact(ctx: ReactCtx, emoji: string): Promise<void> {
  try {
    await ctx.react(emoji);
  } catch (err) {
    logger.warn({ err, emoji }, 'failed to set reaction (ignored)');
  }
}

export const markReceived = (ctx: ReactCtx) => safeReact(ctx, '👀');
export const markWorking  = (ctx: ReactCtx) => safeReact(ctx, '✍');
export const markDone     = (ctx: ReactCtx) => safeReact(ctx, '👍');
export const markFailed   = (ctx: ReactCtx) => safeReact(ctx, '💩');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/bot/reactions.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/bot/reactions.ts tests/bot/reactions.test.ts
git commit -m "feat(bot): reaction state-machine helpers"
```

---

### Task 9: Media-group buffer

**Files:**
- Create: `src/bot/media-group.ts`
- Test: `tests/bot/media-group.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/bot/media-group.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaGroupBuffer } from '../../src/bot/media-group';

describe('MediaGroupBuffer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flushes a single-element group after debounce window', async () => {
    const onFlush = vi.fn();
    const buf = new MediaGroupBuffer<{ id: number }>(50, onFlush);

    buf.add('g1', { id: 1 });
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    await Promise.resolve();
    expect(onFlush).toHaveBeenCalledExactlyOnceWith('g1', [{ id: 1 }]);
  });

  it('extends timer on each addition to the same group', async () => {
    const onFlush = vi.fn();
    const buf = new MediaGroupBuffer<{ id: number }>(50, onFlush);

    buf.add('g1', { id: 1 });
    vi.advanceTimersByTime(40);
    buf.add('g1', { id: 2 });
    vi.advanceTimersByTime(40);
    buf.add('g1', { id: 3 });
    vi.advanceTimersByTime(40);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    await Promise.resolve();
    expect(onFlush).toHaveBeenCalledExactlyOnceWith('g1', [
      { id: 1 }, { id: 2 }, { id: 3 },
    ]);
  });

  it('keeps groups independent', async () => {
    const onFlush = vi.fn();
    const buf = new MediaGroupBuffer<{ id: number }>(50, onFlush);

    buf.add('g1', { id: 1 });
    buf.add('g2', { id: 99 });
    vi.advanceTimersByTime(50);
    await Promise.resolve();
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenCalledWith('g1', [{ id: 1 }]);
    expect(onFlush).toHaveBeenCalledWith('g2', [{ id: 99 }]);
  });

  it('removes group from internal state after flush (re-adding starts fresh)', async () => {
    const onFlush = vi.fn();
    const buf = new MediaGroupBuffer<{ id: number }>(50, onFlush);

    buf.add('g1', { id: 1 });
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    buf.add('g1', { id: 2 });
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenNthCalledWith(2, 'g1', [{ id: 2 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/bot/media-group.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/bot/media-group.ts`**

```ts
// src/bot/media-group.ts
export type FlushHandler<T> = (groupId: string, items: T[]) => void | Promise<void>;

interface Entry<T> {
  items: T[];
  timer: NodeJS.Timeout;
}

export class MediaGroupBuffer<T> {
  private readonly groups = new Map<string, Entry<T>>();

  constructor(
    private readonly debounceMs: number,
    private readonly onFlush: FlushHandler<T>,
  ) {}

  add(groupId: string, item: T): void {
    const existing = this.groups.get(groupId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(item);
      existing.timer = this.scheduleFlush(groupId);
      return;
    }
    this.groups.set(groupId, {
      items: [item],
      timer: this.scheduleFlush(groupId),
    });
  }

  private scheduleFlush(groupId: string): NodeJS.Timeout {
    return setTimeout(() => {
      const entry = this.groups.get(groupId);
      if (!entry) return;
      this.groups.delete(groupId);
      // intentionally fire-and-forget; caller logs errors inside onFlush
      void this.onFlush(groupId, entry.items);
    }, this.debounceMs);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/bot/media-group.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/bot/media-group.ts tests/bot/media-group.test.ts
git commit -m "feat(bot): in-memory media-group buffer with debounce flush"
```

---

### Task 10: Subject prompt builder (pure)

**Files:**
- Create: `src/bot/subject-prompt.ts`
- Test: `tests/bot/subject-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/bot/subject-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildSubjectPrompt, sanitizeSubject, fallbackSubject } from '../../src/bot/subject-prompt';

describe('subject prompt', () => {
  it('builds a prompt that contains the body verbatim', () => {
    const p = buildSubjectPrompt('hello world');
    expect(p).toContain('hello world');
    expect(p).toMatch(/concise/i);
    expect(p).toMatch(/max 80 chars/i);
  });

  it('sanitizes: trims, strips wrapping quotes, removes trailing punctuation', () => {
    expect(sanitizeSubject('  "Hello world."  ')).toBe('Hello world');
    expect(sanitizeSubject(`'It's working!'`)).toBe(`It's working`);
    expect(sanitizeSubject('Subject: foo')).toBe('Subject: foo');
  });

  it('sanitizes: truncates to 80 chars', () => {
    const long = 'a'.repeat(120);
    expect(sanitizeSubject(long).length).toBe(80);
  });

  it('sanitizes empty input → empty string', () => {
    expect(sanitizeSubject('')).toBe('');
    expect(sanitizeSubject('   ')).toBe('');
  });

  it('fallbackSubject formats with username', () => {
    expect(fallbackSubject('alice')).toBe('Telegram message from @alice');
    expect(fallbackSubject(null)).toBe('Telegram message');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/bot/subject-prompt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/bot/subject-prompt.ts`**

```ts
// src/bot/subject-prompt.ts
export function buildSubjectPrompt(body: string): string {
  return `Generate a concise, descriptive email subject (max 80 chars, no quotes, no trailing punctuation) for the following message body. Reply with the subject only, no preamble.

BODY:
${body}`;
}

export function sanitizeSubject(raw: string): string {
  let s = raw.trim();
  if (s.length === 0) return '';
  // strip a single pair of wrapping quotes (matching " or ')
  const m = /^(['"])(.*)\1$/s.exec(s);
  if (m) s = m[2]!.trim();
  // strip ONE trailing punctuation char from the set [. ! ? , ;]
  s = s.replace(/[.!?,;]+$/u, '');
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}

export function fallbackSubject(username: string | null): string {
  return username ? `Telegram message from @${username}` : 'Telegram message';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/bot/subject-prompt.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/bot/subject-prompt.ts tests/bot/subject-prompt.test.ts
git commit -m "feat(bot): pure subject prompt builder, sanitizer, and fallback"
```

---

### Task 11: Email composer (pure)

**Files:**
- Create: `src/bot/email-composer.ts`
- Test: `tests/bot/email-composer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/bot/email-composer.test.ts
import { describe, it, expect } from 'vitest';
import { composeEmail, type ComposeInput } from '../../src/bot/email-composer';

const base: ComposeInput = {
  fromEmail: 'bot@example.com',
  toEmail: 'me@example.com',
  username: 'alice',
  subject: 'Hello',
  body: 'plain text body',
  attachments: [],
  sentAt: new Date('2026-01-02T03:04:05Z'),
};

describe('composeEmail', () => {
  it('builds payload with [TG] prefix and attribution header', () => {
    const p = composeEmail(base);
    expect(p.from).toBe('bot@example.com');
    expect(p.to).toBe('me@example.com');
    expect(p.subject).toBe('[TG] Hello');
    expect(p.text).toContain('Sent by @alice (Telegram) at 2026-01-02T03:04:05.000Z');
    expect(p.text).toContain('plain text body');
    expect(p.html).toContain('Sent by @alice (Telegram)');
    expect(p.html).toContain('plain text body');
    expect(p.attachments).toEqual([]);
  });

  it('escapes HTML in body', () => {
    const p = composeEmail({ ...base, body: '<script>alert(1)</script> & "quotes"' });
    expect(p.html).not.toContain('<script>');
    expect(p.html).toContain('&lt;script&gt;');
    expect(p.html).toContain('&amp;');
    expect(p.html).toContain('&quot;');
  });

  it('falls back to "(no text)" when body is empty', () => {
    const p = composeEmail({ ...base, body: '' });
    expect(p.text).toContain('(no text)');
    expect(p.html).toContain('(no text)');
  });

  it('uses "unknown sender" when username is null', () => {
    const p = composeEmail({ ...base, username: null });
    expect(p.text).toContain('Sent by unknown sender');
  });

  it('passes attachments through as-is', () => {
    const att = [{ filename: 'a.jpg', content: Buffer.from([1, 2, 3]) }];
    const p = composeEmail({ ...base, attachments: att });
    expect(p.attachments).toEqual(att);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/bot/email-composer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/bot/email-composer.ts`**

```ts
// src/bot/email-composer.ts
export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

export interface ComposeInput {
  fromEmail: string;
  toEmail: string;
  username: string | null;
  subject: string;
  body: string;
  attachments: EmailAttachment[];
  sentAt: Date;
}

export interface EmailPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: EmailAttachment[];
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function composeEmail(input: ComposeInput): EmailPayload {
  const senderLabel = input.username ? `@${input.username}` : 'unknown sender';
  const attribution = `Sent by ${senderLabel} (Telegram) at ${input.sentAt.toISOString()}`;
  const body = input.body.trim() === '' ? '(no text)' : input.body;

  const text = `${attribution}\n\n${body}\n`;
  const html = `<p><em>${escapeHtml(attribution)}</em></p>\n<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(body)}</pre>`;

  return {
    from: input.fromEmail,
    to: input.toEmail,
    subject: `[TG] ${input.subject}`,
    text,
    html,
    attachments: input.attachments,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/bot/email-composer.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/bot/email-composer.ts tests/bot/email-composer.test.ts
git commit -m "feat(bot): pure email composer with HTML escaping and attribution"
```

---

### Task 12: Telegram file downloader

**Files:**
- Create: `src/services/telegram-files.ts`
- Test: `tests/services/telegram-files.test.ts`

This wrapper takes a grammy `Api` + `file_id` + `botToken`, returns `{ buffer, filename, mimeType }`. Guards against >20MB.

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/telegram-files.test.ts
import { describe, it, expect, vi } from 'vitest';
import { downloadTelegramFile, TELEGRAM_FILE_MAX_BYTES } from '../../src/services/telegram-files';
import { FatalError } from '../../src/lib/errors';

function mockFetch(status: number, body?: ArrayBuffer) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => body ?? new ArrayBuffer(0),
  });
}

describe('downloadTelegramFile', () => {
  it('downloads a file under the limit', async () => {
    const api = {
      getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file.ogg', file_size: 100 }),
    };
    const fetchImpl = mockFetch(200, new Uint8Array([1, 2, 3]).buffer);
    const result = await downloadTelegramFile({
      api: api as any,
      botToken: 'TOK',
      fileId: 'F',
      fetchImpl,
    });
    expect(result.buffer.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(result.filename).toBe('file.ogg');
    expect(api.getFile).toHaveBeenCalledWith('F');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.telegram.org/file/botTOK/voice/file.ogg'
    );
  });

  it('throws FatalError when file_size exceeds limit', async () => {
    const api = {
      getFile: vi.fn().mockResolvedValue({
        file_path: 'big.bin',
        file_size: TELEGRAM_FILE_MAX_BYTES + 1,
      }),
    };
    await expect(
      downloadTelegramFile({
        api: api as any,
        botToken: 'TOK',
        fileId: 'F',
        fetchImpl: mockFetch(200),
      })
    ).rejects.toBeInstanceOf(FatalError);
  });

  it('throws FatalError on 4xx from Telegram CDN', async () => {
    const api = {
      getFile: vi.fn().mockResolvedValue({ file_path: 'x', file_size: 10 }),
    };
    await expect(
      downloadTelegramFile({
        api: api as any,
        botToken: 'TOK',
        fileId: 'F',
        fetchImpl: mockFetch(404),
      })
    ).rejects.toBeInstanceOf(FatalError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/services/telegram-files.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/services/telegram-files.ts`**

```ts
// src/services/telegram-files.ts
import type { Api } from 'grammy';
import { FatalError, TransientError } from '../lib/errors';

export const TELEGRAM_FILE_MAX_BYTES = 20 * 1024 * 1024;

export interface DownloadInput {
  api: Api;
  botToken: string;
  fileId: string;
  fetchImpl?: typeof fetch;
}

export interface DownloadResult {
  buffer: Buffer;
  filename: string;
  mimeType: string | null;
}

export async function downloadTelegramFile(input: DownloadInput): Promise<DownloadResult> {
  const fetchImpl = input.fetchImpl ?? fetch;

  let file: { file_path?: string; file_size?: number };
  try {
    file = await input.api.getFile(input.fileId);
  } catch (err) {
    throw new TransientError('getFile failed', { provider: 'telegram', detail: err });
  }
  if (!file.file_path) {
    throw new FatalError('telegram returned no file_path', { provider: 'telegram', detail: file });
  }
  if (typeof file.file_size === 'number' && file.file_size > TELEGRAM_FILE_MAX_BYTES) {
    throw new FatalError(
      `file too large (${file.file_size} > ${TELEGRAM_FILE_MAX_BYTES})`,
      { provider: 'telegram', detail: file }
    );
  }

  const url = `https://api.telegram.org/file/bot${input.botToken}/${file.file_path}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    if (res.status >= 500) {
      throw new TransientError(`telegram cdn ${res.status}`, { provider: 'telegram' });
    }
    throw new FatalError(`telegram cdn ${res.status}`, { provider: 'telegram' });
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength > TELEGRAM_FILE_MAX_BYTES) {
    throw new FatalError('downloaded file exceeded size limit', { provider: 'telegram' });
  }
  const buffer = Buffer.from(ab);
  const filename = file.file_path.split('/').pop() ?? 'file.bin';
  return { buffer, filename, mimeType: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/services/telegram-files.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/services/telegram-files.ts tests/services/telegram-files.test.ts
git commit -m "feat(services): Telegram file downloader with size guard"
```

---

### Task 13: Whisper service

**Files:**
- Create: `src/services/whisper.ts`
- Test: `tests/services/whisper.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/whisper.test.ts
import { describe, it, expect, vi } from 'vitest';
import { makeWhisperClient } from '../../src/services/whisper';
import { FatalError, TransientError } from '../../src/lib/errors';

function makeFakeOpenAI(resp: any) {
  return {
    audio: {
      transcriptions: {
        create: vi.fn().mockImplementation(resp),
      },
    },
  };
}

describe('whisper', () => {
  it('returns the transcript text', async () => {
    const fake = makeFakeOpenAI(async () => ({ text: 'hello world' }));
    const w = makeWhisperClient(fake as any);
    const text = await w.transcribe({
      audio: Buffer.from('abc'),
      filename: 'voice.ogg',
    });
    expect(text).toBe('hello world');
    expect(fake.audio.transcriptions.create).toHaveBeenCalledOnce();
  });

  it('throws FatalError on empty transcript', async () => {
    const fake = makeFakeOpenAI(async () => ({ text: '   ' }));
    const w = makeWhisperClient(fake as any);
    await expect(
      w.transcribe({ audio: Buffer.from('abc'), filename: 'voice.ogg' })
    ).rejects.toBeInstanceOf(FatalError);
  });

  it('maps 5xx errors to TransientError', async () => {
    const err: any = new Error('boom');
    err.status = 503;
    const fake = makeFakeOpenAI(async () => { throw err; });
    const w = makeWhisperClient(fake as any);
    await expect(
      w.transcribe({ audio: Buffer.from('abc'), filename: 'voice.ogg' })
    ).rejects.toBeInstanceOf(TransientError);
  });

  it('maps 4xx errors to FatalError', async () => {
    const err: any = new Error('bad');
    err.status = 400;
    const fake = makeFakeOpenAI(async () => { throw err; });
    const w = makeWhisperClient(fake as any);
    await expect(
      w.transcribe({ audio: Buffer.from('abc'), filename: 'voice.ogg' })
    ).rejects.toBeInstanceOf(FatalError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/services/whisper.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/services/whisper.ts`**

```ts
// src/services/whisper.ts
import OpenAI, { toFile } from 'openai';
import { FatalError, TransientError } from '../lib/errors';

export interface WhisperClient {
  transcribe(input: { audio: Buffer; filename: string }): Promise<string>;
}

export function makeWhisperClient(openai: OpenAI): WhisperClient {
  return {
    async transcribe({ audio, filename }) {
      let resp: { text?: string };
      try {
        const file = await toFile(audio, filename);
        resp = await openai.audio.transcriptions.create({
          file,
          model: 'whisper-1',
        });
      } catch (err: any) {
        const status = err?.status as number | undefined;
        if (status && status >= 500) {
          throw new TransientError('whisper 5xx', { provider: 'whisper', detail: err });
        }
        throw new FatalError(`whisper error: ${err?.message ?? 'unknown'}`, {
          provider: 'whisper',
          detail: err,
        });
      }
      const text = (resp.text ?? '').trim();
      if (text.length === 0) {
        throw new FatalError('empty transcript', { provider: 'whisper' });
      }
      return text;
    },
  };
}

export function defaultOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/services/whisper.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/services/whisper.ts tests/services/whisper.test.ts
git commit -m "feat(services): OpenAI Whisper wrapper with error mapping"
```

---

### Task 14: Subject (OpenRouter) service

**Files:**
- Create: `src/services/subject.ts`
- Test: `tests/services/subject.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/subject.test.ts
import { describe, it, expect, vi } from 'vitest';
import { makeSubjectClient } from '../../src/services/subject';

function mockFetch(body: any, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('subject service', () => {
  it('returns the model response on success', async () => {
    const fetchImpl = mockFetch({
      choices: [{ message: { content: '"Lunch plans"' } }],
    });
    const c = makeSubjectClient({
      apiKey: 'k',
      model: 'google/gemini-flash-1.5',
      fetchImpl,
    });
    const subject = await c.generateSubject('let us meet at noon');
    // sanitization happens in the bot layer; here we just return the raw
    expect(subject).toBe('"Lunch plans"');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer k',
          'Content-Type': 'application/json',
        }),
      })
    );
  });

  it('returns null when API returns non-2xx (callers use fallback)', async () => {
    const fetchImpl = mockFetch({}, 500);
    const c = makeSubjectClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await c.generateSubject('x')).toBeNull();
  });

  it('returns null when response shape is missing content', async () => {
    const fetchImpl = mockFetch({ choices: [] });
    const c = makeSubjectClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await c.generateSubject('x')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));
    const c = makeSubjectClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await c.generateSubject('x')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/services/subject.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/services/subject.ts`**

```ts
// src/services/subject.ts
import { z } from 'zod';
import { logger } from '../lib/logger';
import { buildSubjectPrompt } from '../bot/subject-prompt';

export interface SubjectClient {
  generateSubject(body: string): Promise<string | null>;
}

const responseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string(),
      }),
    })
  ).min(1),
});

export interface SubjectClientOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export function makeSubjectClient(opts: SubjectClientOptions): SubjectClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async generateSubject(body) {
      try {
        const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: opts.model,
            messages: [
              { role: 'user', content: buildSubjectPrompt(body) },
            ],
            max_tokens: 60,
            temperature: 0.3,
          }),
        });
        if (!res.ok) {
          logger.warn({ status: res.status }, 'openrouter non-2xx');
          return null;
        }
        const json = await res.json();
        const parsed = responseSchema.safeParse(json);
        if (!parsed.success) {
          logger.warn({ json }, 'openrouter response shape unexpected');
          return null;
        }
        return parsed.data.choices[0]!.message.content;
      } catch (err) {
        logger.warn({ err }, 'openrouter call threw');
        return null;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/services/subject.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/services/subject.ts tests/services/subject.test.ts
git commit -m "feat(services): OpenRouter subject client (single attempt + null on fail)"
```

---

### Task 15: Resend service

**Files:**
- Create: `src/services/resend.ts`
- Test: `tests/services/resend.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/resend.test.ts
import { describe, it, expect, vi } from 'vitest';
import { makeResendClient } from '../../src/services/resend';
import { FatalError, TransientError } from '../../src/lib/errors';

function makeFakeResend(impl: any) {
  return { emails: { send: vi.fn().mockImplementation(impl) } };
}

const payload = {
  from: 'a@b.com', to: 'c@d.com', subject: 's',
  text: 't', html: '<p>t</p>', attachments: [],
};

describe('resend service', () => {
  it('sends and returns the message id', async () => {
    const fake = makeFakeResend(async () => ({ data: { id: 're-id-1' }, error: null }));
    const c = makeResendClient(fake as any);
    const id = await c.send(payload);
    expect(id).toBe('re-id-1');
  });

  it('maps Resend error object with retryable status to TransientError', async () => {
    const fake = makeFakeResend(async () => ({ data: null, error: { name: 'x', message: 'm', statusCode: 503 } }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(TransientError);
  });

  it('maps Resend error object with 4xx to FatalError', async () => {
    const fake = makeFakeResend(async () => ({ data: null, error: { name: 'x', message: 'm', statusCode: 400 } }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(FatalError);
  });

  it('maps thrown 5xx errors to TransientError', async () => {
    const err: any = new Error('boom');
    err.statusCode = 500;
    const fake = makeFakeResend(async () => { throw err; });
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(TransientError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/services/resend.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/services/resend.ts`**

```ts
// src/services/resend.ts
import { Resend } from 'resend';
import { FatalError, TransientError } from '../lib/errors';
import type { EmailPayload } from '../bot/email-composer';

export interface ResendSender {
  send(payload: EmailPayload): Promise<string>; // returns Resend message id
}

function classify(statusCode: number | undefined): 'transient' | 'fatal' {
  if (statusCode && statusCode >= 500) return 'transient';
  return 'fatal';
}

export function makeResendClient(resend: Resend): ResendSender {
  return {
    async send(p) {
      try {
        const result = await resend.emails.send({
          from: p.from,
          to: p.to,
          subject: p.subject,
          text: p.text,
          html: p.html,
          attachments: p.attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
          })),
        });
        if (result.error) {
          const cls = classify(result.error.statusCode);
          const Cls = cls === 'transient' ? TransientError : FatalError;
          throw new Cls(`resend: ${result.error.message}`, {
            provider: 'resend',
            detail: result.error,
          });
        }
        return result.data?.id ?? '';
      } catch (err: any) {
        if (err instanceof TransientError || err instanceof FatalError) throw err;
        const cls = classify(err?.statusCode);
        const Cls = cls === 'transient' ? TransientError : FatalError;
        throw new Cls(`resend: ${err?.message ?? 'unknown'}`, {
          provider: 'resend',
          detail: err,
        });
      }
    },
  };
}

export function defaultResendClient(apiKey: string): Resend {
  return new Resend(apiKey);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/services/resend.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/services/resend.ts tests/services/resend.test.ts
git commit -m "feat(services): Resend wrapper with TransientError/FatalError mapping"
```

---

### Task 16: Onboarding handlers

**Files:**
- Create: `src/bot/onboarding.ts`
- Test: `tests/bot/onboarding.test.ts`

This task wires the auth decision into actual bot replies. It depends on a function `notifyAdminOfNewUser` which we provide as a parameter (the real one is implemented in Task 17).

- [ ] **Step 1: Write the failing test**

```ts
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
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/bot/onboarding.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/bot/onboarding.ts`**

```ts
// src/bot/onboarding.ts
import { z } from 'zod';
import { UserRepo } from '../db/users';
import { decideAction } from './auth';

export interface NotifyAdminInput {
  telegramId: number;
  username: string | null;
  firstName: string | null;
  email: string;
}
export type NotifyAdmin = (input: NotifyAdminInput) => Promise<void>;

export interface OnboardingDeps {
  repo: UserRepo;
  notify: NotifyAdmin;
}

interface OnboardingDepsWithEmail extends OnboardingDeps {
  emailArg: string;
}

interface MinimalCtx {
  from?: { id: number; username?: string; first_name?: string };
  reply(text: string): Promise<unknown>;
}

const emailSchema = z.string().email();

function userView(repo: UserRepo, telegramId: number) {
  const u = repo.findById(telegramId);
  return u ? { telegramId: u.telegramId, status: u.status, isAdmin: u.isAdmin } : null;
}

export async function handleStart(ctx: MinimalCtx, deps: OnboardingDeps): Promise<void> {
  if (!ctx.from) return;
  const action = decideAction(userView(deps.repo, ctx.from.id), { kind: 'start' });
  switch (action.type) {
    case 'create-and-greet':
      deps.repo.upsertNew({
        telegramId: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      });
      await ctx.reply('Hi. Reply with /register your@email.com to get started.');
      return;
    case 'already-set-up':
      await ctx.reply("You're already set up.");
      return;
    case 'ignore':
      return;
    default:
      return; // other action types not produced for /start
  }
}

export async function handleRegister(
  ctx: MinimalCtx,
  deps: OnboardingDepsWithEmail
): Promise<void> {
  if (!ctx.from) return;
  const parsed = emailSchema.safeParse(deps.emailArg);
  if (!parsed.success) {
    await ctx.reply("That's not a valid email address. Try /register your@email.com");
    return;
  }
  const email = parsed.data;
  const action = decideAction(userView(deps.repo, ctx.from.id), { kind: 'register', email });
  switch (action.type) {
    case 'create-and-register':
      deps.repo.upsertNew({
        telegramId: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      });
      deps.repo.setEmail(ctx.from.id, email);
      await deps.notify({
        telegramId: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
        email,
      });
      await ctx.reply('Got it. Waiting for admin approval.');
      return;
    case 'register':
      deps.repo.setEmail(ctx.from.id, email);
      await deps.notify({
        telegramId: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
        email,
      });
      await ctx.reply('Got it. Waiting for admin approval.');
      return;
    case 'cannot-change-email':
      await ctx.reply("You're already set up. Email cannot be changed from here.");
      return;
    case 'ignore':
      return;
    default:
      return;
  }
}

export interface PlainMessageOutcome {
  forwardToApprovedFlow: boolean;
}

export async function handlePlainMessage(
  ctx: MinimalCtx,
  deps: OnboardingDeps
): Promise<PlainMessageOutcome> {
  if (!ctx.from) return { forwardToApprovedFlow: false };
  const action = decideAction(userView(deps.repo, ctx.from.id), { kind: 'message' });
  switch (action.type) {
    case 'forward':
      return { forwardToApprovedFlow: true };
    case 'nag-register':
      await ctx.reply('Please run /register your@email.com first.');
      return { forwardToApprovedFlow: false };
    default:
      return { forwardToApprovedFlow: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/bot/onboarding.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/bot/onboarding.ts tests/bot/onboarding.test.ts
git commit -m "feat(bot): onboarding handlers (/start, /register, plain message gate)"
```

---

### Task 17: Admin notify + callbacks

**Files:**
- Create: `src/bot/admin.ts`
- Test: `tests/bot/admin.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/bot/admin.test.ts
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
    expect(api.sendMessage).toHaveBeenCalledOnce();
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
    expect(repo.findById(9)?.status).toBeUndefined(); // user not created, repo returns null
    expect(api.editMessageText).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/bot/admin.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/bot/admin.ts`**

```ts
// src/bot/admin.ts
import type { Api } from 'grammy';
import { UserRepo } from '../db/users';
import { logger } from '../lib/logger';

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

const buildKeyboard = (telegramId: number) => ({
  inline_keyboard: [[
    { text: 'Approve', callback_data: `approve:${telegramId}` },
    { text: 'Reject', callback_data: `reject:${telegramId}` },
  ]],
});

export function makeAdminModule(opts: AdminModuleOpts): AdminModule {
  return {
    async notifyAdminOfNewUser(input) {
      const handle = input.username ? `@${input.username}` : `id ${input.telegramId}`;
      const text =
        `New user request:\n` +
        `${handle} (id: ${input.telegramId})\n` +
        `email: ${input.email}`;
      await opts.api.sendMessage(opts.adminTelegramUserId, text, {
        reply_markup: buildKeyboard(input.telegramId),
      });
    },

    async handleCallback(ctx) {
      const cq = ctx.callbackQuery;
      if (!cq || !cq.data || !cq.message) return;
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

      if (action === 'approve') {
        opts.repo.setStatus(telegramId, 'APPROVED');
        await opts.api.editMessageText(
          cq.message.chat.id,
          cq.message.message_id,
          `Approved ${handle} ✓`,
          {}
        );
        await opts.api.sendMessage(telegramId, "You're approved. Send away.");
      } else {
        opts.repo.setStatus(telegramId, 'REJECTED');
        await opts.api.editMessageText(
          cq.message.chat.id,
          cq.message.message_id,
          `Rejected ${handle} ✗`,
          {}
        );
        await opts.api.sendMessage(telegramId, 'Your request was declined.');
      }
      await ctx.answerCallbackQuery();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/bot/admin.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/bot/admin.ts tests/bot/admin.test.ts
git commit -m "feat(bot): admin DM + approve/reject callback handlers"
```

---

### Task 18: Forward handler (the main flow)

**Files:**
- Create: `src/bot/forward.ts`
- Test: `tests/bot/forward.test.ts`
- Create: `tests/helpers/fake-ctx.ts`

The handler is the only place that integrates downloaders, Whisper, subject, Resend, and reactions. We test the orchestration with all services mocked.

- [ ] **Step 1: Create test helper `tests/helpers/fake-ctx.ts`**

```ts
// tests/helpers/fake-ctx.ts
import { vi } from 'vitest';
import type { Message } from 'grammy/types';

export interface FakeCtx {
  from: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: 'private' };
  message: Partial<Message> & { message_id: number; date: number };
  react: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
}

export function buildFakeCtx(overrides: Partial<FakeCtx['message']> = {}): FakeCtx {
  return {
    from: { id: 7, username: 'alice', first_name: 'Alice' },
    chat: { id: 7, type: 'private' },
    message: {
      message_id: 1001,
      date: Math.floor(new Date('2026-01-02T03:04:05Z').getTime() / 1000),
      ...overrides,
    },
    react: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/bot/forward.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeForwardHandler } from '../../src/bot/forward';
import { UserRepo } from '../../src/db/users';
import { makeTempDb } from '../helpers/temp-db';
import { buildFakeCtx } from '../helpers/fake-ctx';
import { FatalError } from '../../src/lib/errors';

function makeDeps(overrides: Partial<any> = {}) {
  const repo = new UserRepo(makeTempDb());
  repo.upsertNew({ telegramId: 7, username: 'alice', firstName: 'Alice' });
  repo.setEmail(7, 'alice@x.com');
  repo.setStatus(7, 'APPROVED');
  const deps = {
    repo,
    fromEmail: 'bot@x.com',
    subject: { generateSubject: vi.fn().mockResolvedValue('Lunch plans') },
    whisper: { transcribe: vi.fn().mockResolvedValue('hello voice') },
    resend: { send: vi.fn().mockResolvedValue('re-1') },
    download: vi.fn().mockResolvedValue({
      buffer: Buffer.from([1, 2, 3]),
      filename: 'voice.ogg',
      mimeType: null,
    }),
    retryDelays: [],
    mediaGroupFlushMs: 1,
    api: {} as any,
    botToken: 'TOK',
    ...overrides,
  };
  return { deps, repo };
}

describe('forward handler', () => {
  it('text message: 👀 → ✍ → 👍 with Resend called', async () => {
    const { deps } = makeDeps();
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'hi there' });
    await handler(ctx as any);
    expect(ctx.react.mock.calls.map((c) => c[0])).toEqual(['👀', '✍', '👍']);
    expect(deps.resend.send).toHaveBeenCalledOnce();
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.to).toBe('alice@x.com');
    expect(payload.subject).toBe('[TG] Lunch plans');
    expect(payload.attachments).toEqual([]);
  });

  it('voice message: downloads, transcribes, uses transcript as body, no audio attachment', async () => {
    const { deps } = makeDeps();
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({
      voice: { file_id: 'vf', file_unique_id: 'u', duration: 3 } as any,
    });
    await handler(ctx as any);
    expect(deps.download).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'vf' }));
    expect(deps.whisper.transcribe).toHaveBeenCalledOnce();
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.text).toContain('hello voice');
    expect(payload.attachments).toEqual([]); // voice → transcript only
  });

  it('photo message: downloads largest size and attaches as image.jpg', async () => {
    const { deps } = makeDeps();
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({
      photo: [
        { file_id: 's', file_unique_id: '1', width: 90, height: 90, file_size: 100 },
        { file_id: 'l', file_unique_id: '2', width: 800, height: 800, file_size: 8000 },
      ] as any,
      caption: 'check this out',
    });
    await handler(ctx as any);
    expect(deps.download).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'l' }));
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toBe('photo.jpg');
    expect(payload.text).toContain('check this out');
  });

  it('document message: attaches with original filename', async () => {
    const { deps } = makeDeps({
      download: vi.fn().mockResolvedValue({
        buffer: Buffer.from([1]), filename: 'report.pdf', mimeType: null,
      }),
    });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({
      document: { file_id: 'd', file_unique_id: '1', file_name: 'report.pdf' } as any,
    });
    await handler(ctx as any);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.attachments[0].filename).toBe('report.pdf');
  });

  it('subject fallback when openrouter returns null', async () => {
    const { deps } = makeDeps({
      subject: { generateSubject: vi.fn().mockResolvedValue(null) },
    });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'hi' });
    await handler(ctx as any);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.subject).toBe('[TG] Telegram message from @alice');
  });

  it('FatalError during whisper sets 💩, no email sent', async () => {
    const { deps } = makeDeps({
      whisper: { transcribe: vi.fn().mockRejectedValue(new FatalError('empty', { provider: 'whisper' })) },
    });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({
      voice: { file_id: 'vf', file_unique_id: 'u', duration: 3 } as any,
    });
    await handler(ctx as any);
    expect(ctx.react.mock.calls.map((c) => c[0])).toEqual(['👀', '✍', '💩']);
    expect(deps.resend.send).not.toHaveBeenCalled();
  });

  it('media group: combines multiple messages into one email', async () => {
    const { deps } = makeDeps();
    const handler = makeForwardHandler(deps as any);
    const ctxs = [
      buildFakeCtx({
        media_group_id: 'g1',
        photo: [{ file_id: 'p1', file_unique_id: '1', width: 800, height: 800 }] as any,
        caption: 'group caption',
      }),
      buildFakeCtx({
        media_group_id: 'g1',
        photo: [{ file_id: 'p2', file_unique_id: '2', width: 800, height: 800 }] as any,
      }),
    ];
    for (const c of ctxs) await handler(c as any);

    // Drain timers
    await vi.waitFor(() => {
      expect(deps.resend.send).toHaveBeenCalled();
    });
    expect(deps.resend.send).toHaveBeenCalledOnce();
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.attachments).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- tests/bot/forward.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `src/bot/forward.ts`**

```ts
// src/bot/forward.ts
import type { Api, Context } from 'grammy';
import type { Message, PhotoSize } from 'grammy/types';
import { UserRepo } from '../db/users';
import { withRetry, FatalError, TransientError } from '../lib/errors';
import { logger } from '../lib/logger';
import { composeEmail, type EmailAttachment } from './email-composer';
import { sanitizeSubject, fallbackSubject } from './subject-prompt';
import { MediaGroupBuffer } from './media-group';
import { markReceived, markWorking, markDone, markFailed } from './reactions';
import type { ResendSender } from '../services/resend';
import type { WhisperClient } from '../services/whisper';
import type { SubjectClient } from '../services/subject';

export interface ForwardDeps {
  repo: UserRepo;
  fromEmail: string;
  botToken: string;
  api: Api;
  subject: SubjectClient;
  whisper: WhisperClient;
  resend: ResendSender;
  download: (input: { api: Api; botToken: string; fileId: string }) => Promise<{
    buffer: Buffer;
    filename: string;
    mimeType: string | null;
  }>;
  mediaGroupFlushMs: number;
  retryDelays: number[]; // e.g. [500, 2000, 8000]
}

interface MsgKind {
  fileId: string | null;
  filenameHint: string | null;
  isVoice: boolean;
  text: string;
}

function classify(msg: Message): MsgKind {
  if (msg.voice) {
    return { fileId: msg.voice.file_id, filenameHint: 'voice.ogg', isVoice: true, text: '' };
  }
  if (msg.photo && msg.photo.length > 0) {
    const largest = [...msg.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]!;
    return { fileId: largest.file_id, filenameHint: 'photo.jpg', isVoice: false, text: msg.caption ?? '' };
  }
  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      filenameHint: msg.document.file_name ?? 'document',
      isVoice: false,
      text: msg.caption ?? '',
    };
  }
  if (msg.video) {
    return { fileId: msg.video.file_id, filenameHint: msg.video.file_name ?? 'video.mp4', isVoice: false, text: msg.caption ?? '' };
  }
  if (msg.audio) {
    return { fileId: msg.audio.file_id, filenameHint: msg.audio.file_name ?? 'audio.mp3', isVoice: false, text: msg.caption ?? '' };
  }
  if (msg.animation) {
    return { fileId: msg.animation.file_id, filenameHint: msg.animation.file_name ?? 'animation.mp4', isVoice: false, text: msg.caption ?? '' };
  }
  if (msg.sticker) {
    return { fileId: msg.sticker.file_id, filenameHint: msg.sticker.is_animated ? 'sticker.tgs' : 'sticker.webp', isVoice: false, text: '' };
  }
  return { fileId: null, filenameHint: null, isVoice: false, text: msg.text ?? msg.caption ?? '' };
}

export function makeForwardHandler(deps: ForwardDeps) {
  type Pending = { ctx: Context; user: { email: string; username: string | null } };
  const buffer = new MediaGroupBuffer<Pending>(deps.mediaGroupFlushMs, async (groupId, items) => {
    try {
      await processGroup(items);
    } catch (err) {
      logger.error({ err, groupId }, 'media-group flush failed');
      for (const it of items) await markFailed(it.ctx as any);
    }
  });

  async function processGroup(items: Array<{ ctx: Context; user: { email: string; username: string | null } }>): Promise<void> {
    if (items.length === 0) return;
    const first = items[0]!;
    // Mark all as working
    for (const it of items) await markWorking(it.ctx as any);

    const attachments: EmailAttachment[] = [];
    const captions: string[] = [];
    for (const it of items) {
      const msg = it.ctx.message;
      if (!msg) continue;
      const kind = classify(msg);
      if (kind.fileId) {
        const dl = await withRetry(
          () => deps.download({ api: deps.api, botToken: deps.botToken, fileId: kind.fileId! }),
          { delaysMs: deps.retryDelays }
        );
        attachments.push({ filename: kind.filenameHint ?? dl.filename, content: dl.buffer });
      }
      if (kind.text) captions.push(kind.text);
    }
    const body = captions.join('\n\n');
    const subjectInput = body || `(${attachments.length} attachments)`;
    const rawSubject = await deps.subject.generateSubject(subjectInput);
    const subject = rawSubject ? (sanitizeSubject(rawSubject) || fallbackSubject(first.user.username))
                               : fallbackSubject(first.user.username);

    const payload = {
      ...composeEmail({
        fromEmail: deps.fromEmail,
        toEmail: first.user.email,
        username: first.user.username,
        subject,
        body,
        attachments,
        sentAt: new Date(),
      }),
    };
    await withRetry(() => deps.resend.send(payload), { delaysMs: deps.retryDelays });

    for (const it of items) await markDone(it.ctx as any);
    deps.repo.logAudit({
      telegramId: first.ctx.from?.id ?? 0,
      chatMessageId: first.ctx.message?.message_id ?? null,
      event: 'emailed',
      details: JSON.stringify({ group: items.length, attachments: attachments.length }),
    });
  }

  return async function handle(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg || !ctx.from) return;
    const user = deps.repo.findById(ctx.from.id);
    if (!user || user.status !== 'APPROVED' || !user.email) return;

    deps.repo.logAudit({
      telegramId: ctx.from.id,
      chatMessageId: msg.message_id,
      event: 'received',
      details: null,
    });

    await markReceived(ctx as any);

    // Media group: buffer and bail
    if (msg.media_group_id) {
      buffer.add(msg.media_group_id, { ctx, user: { email: user.email, username: user.username } });
      return;
    }

    try {
      await markWorking(ctx as any);
      const kind = classify(msg);

      const attachments: EmailAttachment[] = [];
      let body = kind.text;

      if (kind.fileId && !kind.isVoice) {
        const dl = await withRetry(
          () => deps.download({ api: deps.api, botToken: deps.botToken, fileId: kind.fileId! }),
          { delaysMs: deps.retryDelays }
        );
        attachments.push({ filename: kind.filenameHint ?? dl.filename, content: dl.buffer });
      } else if (kind.fileId && kind.isVoice) {
        const dl = await withRetry(
          () => deps.download({ api: deps.api, botToken: deps.botToken, fileId: kind.fileId! }),
          { delaysMs: deps.retryDelays }
        );
        body = await withRetry(
          () => deps.whisper.transcribe({ audio: dl.buffer, filename: dl.filename }),
          { delaysMs: deps.retryDelays }
        );
        deps.repo.logAudit({
          telegramId: ctx.from.id,
          chatMessageId: msg.message_id,
          event: 'transcribed',
          details: null,
        });
      }

      const subjectInput = body || (attachments.length > 0 ? `(${attachments.length} attachment)` : '(no text)');
      const rawSubject = await deps.subject.generateSubject(subjectInput);
      const subject = rawSubject ? (sanitizeSubject(rawSubject) || fallbackSubject(user.username))
                                 : fallbackSubject(user.username);

      const payload = composeEmail({
        fromEmail: deps.fromEmail,
        toEmail: user.email,
        username: user.username,
        subject,
        body,
        attachments,
        sentAt: new Date(),
      });
      await withRetry(() => deps.resend.send(payload), { delaysMs: deps.retryDelays });
      await markDone(ctx as any);
      deps.repo.logAudit({
        telegramId: ctx.from.id,
        chatMessageId: msg.message_id,
        event: 'emailed',
        details: null,
      });
    } catch (err) {
      const cls = err instanceof TransientError ? 'TransientError'
                : err instanceof FatalError ? 'FatalError' : 'Unknown';
      logger.error({ err, cls, msgId: msg.message_id }, 'forward failed');
      await markFailed(ctx as any);
      deps.repo.logAudit({
        telegramId: ctx.from.id,
        chatMessageId: msg.message_id,
        event: 'error',
        details: JSON.stringify({ class: cls, message: (err as Error)?.message }),
      });
    }
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/bot/forward.test.ts`
Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add src/bot/forward.ts tests/bot/forward.test.ts tests/helpers/fake-ctx.ts
git commit -m "feat(bot): main forward handler with reactions, retry, and media-group buffering"
```

---

### Task 19: Bot wiring (`src/bot/index.ts`)

**Files:**
- Create: `src/bot/index.ts`

No new tests — wiring is exercised by manual smoke test post-deploy. Each handler is already unit-tested.

- [ ] **Step 1: Implement `src/bot/index.ts`**

```ts
// src/bot/index.ts
import { Bot, type Context } from 'grammy';
import type { Config } from '../config';
import { UserRepo } from '../db/users';
import { handleStart, handleRegister, handlePlainMessage } from './onboarding';
import { makeAdminModule } from './admin';
import { makeForwardHandler } from './forward';
import { makeWhisperClient, defaultOpenAIClient } from '../services/whisper';
import { makeSubjectClient } from '../services/subject';
import { makeResendClient, defaultResendClient } from '../services/resend';
import { downloadTelegramFile } from '../services/telegram-files';
import { logger } from '../lib/logger';

export function buildBot(config: Config, repo: UserRepo): Bot {
  const bot = new Bot(config.telegramBotToken);

  const whisper = makeWhisperClient(defaultOpenAIClient(config.openaiApiKey));
  const subject = makeSubjectClient({
    apiKey: config.openrouterApiKey,
    model: config.openrouterModel,
  });
  const resend = makeResendClient(defaultResendClient(config.resendApiKey));

  const admin = makeAdminModule({
    api: bot.api,
    adminTelegramUserId: config.adminTelegramUserId,
    repo,
  });

  const forward = makeForwardHandler({
    repo,
    fromEmail: config.resendFromEmail,
    botToken: config.telegramBotToken,
    api: bot.api,
    subject,
    whisper,
    resend,
    download: ({ api, botToken, fileId }) => downloadTelegramFile({ api, botToken, fileId }),
    mediaGroupFlushMs: config.mediaGroupFlushMs,
    retryDelays: [500, 2000, 8000],
  });

  // Commands first so they don't get caught by the plain-message handler.
  bot.command('start', (ctx) => handleStart(ctx as any, { repo, notify: admin.notifyAdminOfNewUser }));
  bot.command('register', (ctx) => {
    const arg = ctx.match.trim();
    return handleRegister(ctx as any, {
      repo,
      notify: admin.notifyAdminOfNewUser,
      emailArg: arg,
    });
  });

  bot.callbackQuery(/^(approve|reject):\d+$/, (ctx) => admin.handleCallback(ctx as any));

  bot.on('message', async (ctx: Context) => {
    const out = await handlePlainMessage(ctx as any, { repo, notify: admin.notifyAdminOfNewUser });
    if (out.forwardToApprovedFlow) await forward(ctx);
  });

  bot.catch((err) => {
    logger.error({ err: err.error, ctxUpdate: err.ctx.update }, 'unhandled bot error');
  });

  return bot;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(bot): wire commands, callbacks, and message handler"
```

---

### Task 20: Main entry point

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Implement `src/index.ts`**

```ts
// src/index.ts
import 'dotenv/config';
import { parseConfig } from './config';
import { openDatabase } from './db/index';
import { UserRepo } from './db/users';
import { buildBot } from './bot/index';
import { logger } from './lib/logger';

async function main(): Promise<void> {
  const config = parseConfig(process.env as Record<string, string | undefined>);
  const db = openDatabase(config.dbPath);
  const repo = new UserRepo(db);
  repo.seedAdmin({ telegramId: config.adminTelegramUserId, email: config.adminEmail });

  const bot = buildBot(config, repo);

  const stop = async (signal: string) => {
    logger.info({ signal }, 'stopping bot');
    await bot.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  logger.info({ admin: config.adminTelegramUserId }, 'starting bot (long polling)');
  await bot.start({
    allowed_updates: ['message', 'callback_query'],
    onStart: (botInfo) => logger.info({ bot: botInfo.username }, 'bot online'),
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'bot failed to start');
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: no errors; `dist/index.js` exists; `dist/db/schema.sql` exists.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: main entry point with config, db bootstrap, and graceful shutdown"
```

---

### Task 21: Docker packaging

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create `.dockerignore`**

```
node_modules
dist
data
.env
.env.*
.git
.gitignore
*.log
coverage
.vitest
docs
tests
```

- [ ] **Step 3: Create `docker-compose.yml`**

```yaml
services:
  telemach-bot:
    build: .
    image: telemach-bot:latest
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/data
    environment:
      DB_PATH: /data/bot.db
```

- [ ] **Step 4: Build the image locally**

Run: `docker build -t telemach-bot:latest .`
Expected: build completes; final image present in `docker images`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml
git commit -m "build: Docker image (two-stage, non-root) with /data volume"
```

---

### Task 22: README run instructions

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# telemach-bot

A personal Telegram bot that forwards messages, attachments, and transcribed
voice notes to your email. Subject lines generated by an LLM via OpenRouter,
delivery via Resend. Multi-user with admin approval. Single container, one
mounted data volume.

See `docs/superpowers/specs/2026-05-18-telegram-email-bot-design.md` for the
full design.

## Quick start (Docker)

1. Copy `.env.example` to `.env` and fill in:
   - `TELEGRAM_BOT_TOKEN` from @BotFather
   - `ADMIN_TELEGRAM_USER_ID` (your numeric Telegram user id, ask @userinfobot)
   - `ADMIN_EMAIL`
   - `OPENAI_API_KEY` (for Whisper)
   - `OPENROUTER_API_KEY`
   - `RESEND_API_KEY` and `RESEND_FROM_EMAIL` (must be a verified Resend domain)
2. `mkdir -p data`
3. `docker compose up -d --build`
4. DM your bot `/start`.

## Development

```bash
npm install
npm test
npm run dev
```

## How it works

- `/start` → bot greets, asks for `/register your@email.com`.
- `/register` → bot stores email, DMs admin with Approve/Reject buttons.
- After approval, forwarded messages are acknowledged with reactions only:
  👀 received → ✍ working → 👍 sent (or 💩 on error).
- Voice messages are transcribed by OpenAI Whisper; the transcript is sent as
  the email body. Original audio is not attached.
- Photos/documents/videos/audio/animations/stickers are attached verbatim.
- Multiple photos uploaded together bundle into one email.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with quick start and dev instructions"
```

---

### Task 23: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all tests across `tests/**/*.test.ts` pass.

- [ ] **Step 2: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: no errors; `dist/index.js` and `dist/db/schema.sql` exist.

- [ ] **Step 3: Verify Docker image runs and exits cleanly when env is missing**

Run: `docker run --rm telemach-bot:latest`
Expected: container starts, logs a fatal "Invalid environment" message (because no `.env` is mounted), exits with code 1. This proves the env-validation gate works.

- [ ] **Step 4: Manual smoke test on a real bot (out of CI scope)**

Steps for the human operator:
1. Create a Telegram bot via @BotFather; copy the token.
2. Find your Telegram user id via @userinfobot.
3. Verify a domain in Resend; set `RESEND_FROM_EMAIL` to e.g. `bot@yourdomain.com`.
4. Fill in `.env`.
5. `docker compose up -d --build`.
6. DM the bot `/start`, then `/register <your-email>`.
7. Confirm you receive the admin DM as the same user (admin == self). Approve.
8. Send a text → expect email + 👀 ✍ 👍 reactions on the original message.
9. Send a voice note → expect transcript in email body.
10. Send 3 photos together → expect one email with 3 attachments.
11. Send a 21 MB file → expect 💩 reaction (deliberate fail).

---

## Done criteria

- All unit tests pass.
- `npm run build` produces a working `dist/`.
- `docker build` succeeds; `docker compose up` starts the bot.
- A live `/start` → `/register` → admin approve → send-text flow works end-to-end against real Telegram, Whisper, OpenRouter, and Resend.
