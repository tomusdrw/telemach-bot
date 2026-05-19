# Calendar Invite Attachment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a forwarded Telegram message contains a date, attach a valid `.ics` calendar file to the outgoing email so the recipient can add the event to their calendar in one click.

**Architecture:** A new OpenRouter call (parallel with subject generation) extracts an `EventData` from the message body. A pure `ics-builder` turns that into an RFC 5545 calendar file via `ical-generator`. The `.ics` is appended to the email's attachments; the email body gets a small "📅 Event attached: …" note. Per-user IANA timezone (default `Europe/Warsaw`, settable via `/timezone <iana>`) controls all date interpretation. Failures (no event, low confidence, network, parse) degrade silently to "no calendar invite" without affecting the email.

**Tech Stack:** TypeScript (strict), grammy, better-sqlite3, OpenRouter JSON-mode, Resend, `ical-generator` (new dep), vitest.

**Spec:** `docs/superpowers/specs/2026-05-19-calendar-invite-attachment-design.md` — read first if anything is ambiguous.

---

## Task 1: Add `timezone` column to users + migration + repo support

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/index.ts`
- Modify: `src/db/users.ts`
- Modify: `tests/db/users.test.ts`

### - [ ] Step 1: Write failing tests for `users.timezone` and `updateTimezone`

Append to `tests/db/users.test.ts` (inside the existing `describe('UserRepo', …)` block):

```ts
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
```

### - [ ] Step 2: Run tests to verify they fail

Run: `npx vitest run tests/db/users.test.ts`
Expected: 3 failures referencing `timezone`/`updateTimezone` not existing.

### - [ ] Step 3: Add the column to the schema

Edit `src/db/schema.sql` — replace the `users` table block with:

```sql
CREATE TABLE IF NOT EXISTS users (
  telegram_id   INTEGER PRIMARY KEY,
  username      TEXT,
  first_name    TEXT,
  email         TEXT,
  status        TEXT NOT NULL
                 CHECK (status IN ('PENDING_EMAIL','PENDING_APPROVAL','APPROVED','REJECTED')),
  is_admin      INTEGER NOT NULL DEFAULT 0,
  timezone      TEXT NOT NULL DEFAULT 'Europe/Warsaw',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

### - [ ] Step 4: Add migration check to `openDatabase`

Edit `src/db/index.ts` to (a) run the schema bootstrap then (b) ensure `timezone` exists on legacy DBs:

```ts
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
```

### - [ ] Step 5: Extend `UserRepo` with `timezone` reads and `updateTimezone`

Edit `src/db/users.ts`:

a) Extend `User` interface (after `isAdmin`):

```ts
export interface User {
  telegramId: number;
  username: string | null;
  firstName: string | null;
  email: string | null;
  status: UserStatus;
  isAdmin: boolean;
  timezone: string;
  createdAt: number;
  updatedAt: number;
}
```

b) Extend `UserRow` interface (after `is_admin`):

```ts
interface UserRow {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  email: string | null;
  status: UserStatus;
  is_admin: number;
  timezone: string;
  created_at: number;
  updated_at: number;
}
```

c) Extend `rowToUser`:

```ts
const rowToUser = (r: UserRow): User => ({
  telegramId: r.telegram_id,
  username: r.username,
  firstName: r.first_name,
  email: r.email,
  status: r.status,
  isAdmin: r.is_admin === 1,
  timezone: r.timezone,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
```

d) Extend `AuditInput` event union (we'll use these in later tasks):

```ts
export interface AuditInput {
  telegramId: number;
  chatMessageId: number | null;
  event:
    | 'received'
    | 'transcribed'
    | 'emailed'
    | 'error'
    | 'event_extracted'
    | 'event_attached'
    | 'timezone_changed';
  details: string | null;
}
```

e) Add `updateTimezone` method to `UserRepo` (place near `setStatus`):

```ts
  updateTimezone(telegramId: number, timezone: string): void {
    const t = now();
    this.db
      .prepare(`UPDATE users SET timezone = ?, updated_at = ? WHERE telegram_id = ?`)
      .run(timezone, t, telegramId);
  }
```

### - [ ] Step 6: Run tests to verify they pass

Run: `npx vitest run tests/db/users.test.ts`
Expected: all UserRepo tests PASS, including the 3 new ones.

### - [ ] Step 7: Run the full test suite to confirm nothing regressed

Run: `npm test`
Expected: all existing tests PASS (some forward/email tests may use `User` shape indirectly; the new optional field with a default has no behavioral effect).

### - [ ] Step 8: Run typecheck and lint

Run: `npm run typecheck && npm run lint`
Expected: no errors.

### - [ ] Step 9: Commit

```bash
git add src/db/schema.sql src/db/index.ts src/db/users.ts tests/db/users.test.ts
git commit -m "feat(db): add users.timezone column with idempotent migration"
```

---

## Task 2: `/timezone` command

**Files:**
- Create: `src/bot/timezone-cmd.ts`
- Modify: `src/bot/index.ts`
- Create: `tests/bot/timezone-cmd.test.ts`

### - [ ] Step 1: Write the failing test

Create `tests/bot/timezone-cmd.test.ts`:

```ts
// tests/bot/timezone-cmd.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTimezoneCommand } from '../../src/bot/timezone-cmd';
import type { DB } from '../../src/db/index';
import { UserRepo } from '../../src/db/users';
import { makeTempDb } from '../helpers/temp-db';

function fakeCtx(arg = '', from = { id: 7 }) {
  return {
    from,
    match: arg,
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
    const ctx = fakeCtx('');
    await handleTimezoneCommand(ctx as any, { repo });
    expect(ctx.reply).toHaveBeenCalledWith('Your timezone: Europe/Warsaw');
  });

  it('valid IANA arg updates DB and replies success', async () => {
    const ctx = fakeCtx('America/New_York');
    await handleTimezoneCommand(ctx as any, { repo });
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
    const ctx = fakeCtx('Foo/Bar');
    await handleTimezoneCommand(ctx as any, { repo });
    expect(repo.findById(7)?.timezone).toBe('Europe/Warsaw');
    expect(ctx.reply).toHaveBeenCalledWith(
      "Unknown timezone. Use an IANA name like 'Europe/Warsaw' or 'America/New_York'.",
    );
  });

  it('non-approved user: no reply, no write', async () => {
    repo.setStatus(7, 'PENDING_APPROVAL');
    const ctx = fakeCtx('America/New_York');
    await handleTimezoneCommand(ctx as any, { repo });
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(repo.findById(7)?.timezone).toBe('Europe/Warsaw');
  });

  it('unknown user: no reply, no write', async () => {
    const ctx = fakeCtx('America/New_York', { id: 999 });
    await handleTimezoneCommand(ctx as any, { repo });
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
```

### - [ ] Step 2: Run test to verify it fails

Run: `npx vitest run tests/bot/timezone-cmd.test.ts`
Expected: FAIL — `handleTimezoneCommand` not defined.

### - [ ] Step 3: Implement the command handler

Create `src/bot/timezone-cmd.ts`:

```ts
// src/bot/timezone-cmd.ts
import type { UserRepo } from '../db/users';

export interface TimezoneCmdCtx {
  from?: { id: number };
  match: string | RegExpMatchArray;
  reply(text: string): Promise<unknown>;
}

export interface TimezoneCmdDeps {
  repo: UserRepo;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function handleTimezoneCommand(
  ctx: TimezoneCmdCtx,
  deps: TimezoneCmdDeps,
): Promise<void> {
  if (!ctx.from) return;
  const user = deps.repo.findById(ctx.from.id);
  if (!user || user.status !== 'APPROVED') return;

  const arg = String(ctx.match ?? '').trim();
  if (arg === '') {
    await ctx.reply(`Your timezone: ${user.timezone}`);
    return;
  }

  if (!isValidTimezone(arg)) {
    await ctx.reply(
      "Unknown timezone. Use an IANA name like 'Europe/Warsaw' or 'America/New_York'.",
    );
    return;
  }

  const from = user.timezone;
  deps.repo.updateTimezone(user.telegramId, arg);
  deps.repo.logAudit({
    telegramId: user.telegramId,
    chatMessageId: null,
    event: 'timezone_changed',
    details: JSON.stringify({ from, to: arg }),
  });
  await ctx.reply(`Timezone updated: ${arg}`);
}
```

### - [ ] Step 4: Wire the command into the bot

Edit `src/bot/index.ts`:

a) Import the handler near the other bot module imports:

```ts
import { handleTimezoneCommand } from './timezone-cmd';
```

b) Add a `bot.command('timezone', …)` registration after the `bot.command('reset', …)` line:

```ts
  bot.command('timezone', (ctx) => handleTimezoneCommand(ctx, { repo }));
```

### - [ ] Step 5: Run tests to verify they pass

Run: `npx vitest run tests/bot/timezone-cmd.test.ts`
Expected: all 5 tests PASS.

### - [ ] Step 6: Run typecheck, lint, full suite

Run: `npm run typecheck && npm run lint && npm test`
Expected: green.

### - [ ] Step 7: Commit

```bash
git add src/bot/timezone-cmd.ts src/bot/index.ts tests/bot/timezone-cmd.test.ts
git commit -m "feat(bot): /timezone command (set/get user IANA timezone)"
```

---

## Task 3: Add 📅 to reactions + `markEventAttached`

**Files:**
- Modify: `src/bot/reactions.ts`
- Modify: `tests/bot/reactions.test.ts`

### - [ ] Step 1: Write the failing test

Append to `tests/bot/reactions.test.ts` (inside the existing `describe('reactions', …)` block):

```ts
  it('markEventAttached sets 📅', async () => {
    const ctx = fakeCtx();
    const { markEventAttached } = await import('../../src/bot/reactions');
    await markEventAttached(ctx as any);
    expect(ctx._react).toHaveBeenCalledWith('📅');
  });
```

### - [ ] Step 2: Run test to verify it fails

Run: `npx vitest run tests/bot/reactions.test.ts`
Expected: FAIL — `markEventAttached` not exported.

### - [ ] Step 3: Add 📅 to the union and export the helper

Edit `src/bot/reactions.ts`:

```ts
import { logger } from '../lib/logger';

export type ReactionEmoji = '👀' | '✍' | '👍' | '💩' | '📅';

export interface ReactCtx {
  react(emoji: ReactionEmoji): Promise<unknown>;
}

async function safeReact(ctx: ReactCtx, emoji: ReactionEmoji): Promise<void> {
  try {
    await ctx.react(emoji);
  } catch (err) {
    logger.warn({ err, emoji }, 'failed to set reaction (ignored)');
  }
}

export const markReceived = (ctx: ReactCtx) => safeReact(ctx, '👀');
export const markWorking = (ctx: ReactCtx) => safeReact(ctx, '✍');
export const markDone = (ctx: ReactCtx) => safeReact(ctx, '👍');
export const markFailed = (ctx: ReactCtx) => safeReact(ctx, '💩');
export const markEventAttached = (ctx: ReactCtx) => safeReact(ctx, '📅');
```

### - [ ] Step 4: Run tests to verify they pass

Run: `npx vitest run tests/bot/reactions.test.ts`
Expected: all 6 tests PASS.

### - [ ] Step 5: Commit

```bash
git add src/bot/reactions.ts tests/bot/reactions.test.ts
git commit -m "feat(bot): add 📅 reaction (markEventAttached)"
```

---

## Task 4: Extend `EmailAttachment` with optional `contentType`

**Files:**
- Modify: `src/bot/email-composer.ts`
- Modify: `src/services/resend.ts`
- Modify: `tests/bot/email-composer.test.ts`
- Modify: `tests/services/resend.test.ts`

### - [ ] Step 1: Write the failing tests

Append to `tests/bot/email-composer.test.ts` (inside the existing `describe('composeEmail', …)` block):

```ts
  it('passes contentType through on attachments when present', () => {
    const att = [
      {
        filename: 'event.ics',
        content: Buffer.from('BEGIN:VCALENDAR'),
        contentType: 'text/calendar; method=PUBLISH; charset=UTF-8',
      },
    ];
    const p = composeEmail({ ...base, attachments: att });
    expect(p.attachments[0]?.contentType).toBe('text/calendar; method=PUBLISH; charset=UTF-8');
  });
```

Append to `tests/services/resend.test.ts` — read the existing file first, then add a test that verifies attachments include `contentType` when set. Pattern:

```ts
  it('forwards attachment contentType to Resend SDK when present', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'r-1' }, error: null });
    const sender = makeResendClient({ emails: { send } } as any);
    await sender.send({
      from: 'a@x.com',
      to: 'b@x.com',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
      attachments: [
        {
          filename: 'event.ics',
          content: Buffer.from('x'),
          contentType: 'text/calendar; method=PUBLISH; charset=UTF-8',
        },
      ],
    });
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0];
    expect(payload.attachments[0]).toMatchObject({
      filename: 'event.ics',
      contentType: 'text/calendar; method=PUBLISH; charset=UTF-8',
    });
  });
```

### - [ ] Step 2: Run tests to verify they fail

Run: `npx vitest run tests/bot/email-composer.test.ts tests/services/resend.test.ts`
Expected: both new tests FAIL — `contentType` field doesn't exist on `EmailAttachment`.

### - [ ] Step 3: Add optional `contentType` to `EmailAttachment`

Edit `src/bot/email-composer.ts` — update the `EmailAttachment` interface:

```ts
export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}
```

(No other changes needed in `composeEmail`; it spreads `attachments` through.)

### - [ ] Step 4: Forward `contentType` in the Resend wrapper

Edit `src/services/resend.ts` — update the `attachments.map(...)` block inside `send`:

```ts
          attachments: p.attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            ...(a.contentType ? { contentType: a.contentType } : {}),
          })),
```

### - [ ] Step 5: Run tests to verify they pass

Run: `npx vitest run tests/bot/email-composer.test.ts tests/services/resend.test.ts`
Expected: all PASS.

### - [ ] Step 6: Run typecheck + lint

Run: `npm run typecheck && npm run lint`
Expected: green.

### - [ ] Step 7: Commit

```bash
git add src/bot/email-composer.ts src/services/resend.ts tests/bot/email-composer.test.ts tests/services/resend.test.ts
git commit -m "feat(bot): EmailAttachment supports optional contentType"
```

---

## Task 5: `event-prompt.ts` — `EventData` type, prompt builder, response parser

**Files:**
- Create: `src/bot/event-prompt.ts`
- Create: `tests/bot/event-prompt.test.ts`

### - [ ] Step 1: Write the failing tests

Create `tests/bot/event-prompt.test.ts`:

```ts
// tests/bot/event-prompt.test.ts
import { describe, expect, it } from 'vitest';
import { buildEventPrompt, parseEventResponse } from '../../src/bot/event-prompt';

describe('buildEventPrompt', () => {
  it('includes timezone and nowInTz verbatim', () => {
    const p = buildEventPrompt({
      body: 'Spotkanie w czwartek o 14:10',
      nowInTz: '2026-05-19 09:00',
      timezone: 'Europe/Warsaw',
    });
    expect(p).toContain('Europe/Warsaw');
    expect(p).toContain('2026-05-19 09:00');
    expect(p).toContain('Spotkanie w czwartek o 14:10');
  });

  it('instructs the model to return JSON with "event": null when unsure', () => {
    const p = buildEventPrompt({ body: 'random', nowInTz: '2026-05-19 09:00', timezone: 'UTC' });
    expect(p).toMatch(/"event"\s*:\s*null/);
  });
});

describe('parseEventResponse', () => {
  it('returns the event for a well-formed all-day single day', () => {
    const r = parseEventResponse({
      event: {
        summary: 'Turnus',
        allDay: true,
        start: '2026-05-14',
        end: '2026-05-14',
        location: null,
        description: null,
      },
    });
    expect(r).toEqual({
      summary: 'Turnus',
      allDay: true,
      start: '2026-05-14',
      end: '2026-05-14',
      location: null,
      description: null,
    });
  });

  it('returns the event for a well-formed all-day range', () => {
    const r = parseEventResponse({
      event: {
        summary: 'Turnus',
        allDay: true,
        start: '2026-05-14',
        end: '2026-05-16',
        location: null,
        description: null,
      },
    });
    expect(r?.end).toBe('2026-05-16');
  });

  it('returns the event for a timed event with explicit end', () => {
    const r = parseEventResponse({
      event: {
        summary: 'Spotkanie',
        allDay: false,
        start: '2026-05-21T14:10',
        end: '2026-05-21T15:10',
        location: null,
        description: null,
      },
    });
    expect(r?.allDay).toBe(false);
    expect(r?.end).toBe('2026-05-21T15:10');
  });

  it('fills missing end with start + 1h for timed events', () => {
    const r = parseEventResponse({
      event: {
        summary: 'Spotkanie',
        allDay: false,
        start: '2026-05-21T14:10',
        location: null,
        description: null,
      },
    });
    expect(r?.end).toBe('2026-05-21T15:10');
  });

  it('null event → null', () => {
    expect(parseEventResponse({ event: null })).toBeNull();
  });

  it('end < start → null', () => {
    const r = parseEventResponse({
      event: {
        summary: 'X',
        allDay: true,
        start: '2026-05-16',
        end: '2026-05-14',
        location: null,
        description: null,
      },
    });
    expect(r).toBeNull();
  });

  it('empty summary → null', () => {
    const r = parseEventResponse({
      event: {
        summary: '',
        allDay: true,
        start: '2026-05-14',
        end: '2026-05-14',
        location: null,
        description: null,
      },
    });
    expect(r).toBeNull();
  });

  it('malformed input → null', () => {
    expect(parseEventResponse({ event: { summary: 'x' } })).toBeNull();
    expect(parseEventResponse(null)).toBeNull();
    expect(parseEventResponse('not json')).toBeNull();
  });

  it('all-day with non-date strings → null', () => {
    const r = parseEventResponse({
      event: {
        summary: 'X',
        allDay: true,
        start: '2026-05-14T10:00',
        end: '2026-05-14T11:00',
        location: null,
        description: null,
      },
    });
    expect(r).toBeNull();
  });

  it('timed with date-only strings → null', () => {
    const r = parseEventResponse({
      event: {
        summary: 'X',
        allDay: false,
        start: '2026-05-14',
        end: '2026-05-14',
        location: null,
        description: null,
      },
    });
    expect(r).toBeNull();
  });
});
```

### - [ ] Step 2: Run tests to verify they fail

Run: `npx vitest run tests/bot/event-prompt.test.ts`
Expected: FAIL — module does not exist.

### - [ ] Step 3: Implement `event-prompt.ts`

Create `src/bot/event-prompt.ts`:

```ts
// src/bot/event-prompt.ts
import { z } from 'zod';

export interface EventData {
  summary: string;
  allDay: boolean;
  start: string;
  end: string;
  location: string | null;
  description: string | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const rawEventSchema = z.object({
  summary: z.string(),
  allDay: z.boolean(),
  start: z.string(),
  end: z.string().optional(),
  location: z.string().nullable(),
  description: z.string().nullable(),
});

const envelopeSchema = z.object({
  event: rawEventSchema.nullable(),
});

export function buildEventPrompt(input: {
  body: string;
  nowInTz: string;
  timezone: string;
}): string {
  return `You extract a single calendar event from a chat message. Return JSON only.

Current local time: ${input.nowInTz}
Timezone: ${input.timezone}

Rules:
- Interpret all extracted times as local to the timezone above (no conversion).
- Resolve relative dates ("tomorrow", "next weekend", "w czwartek") relative to the current local time.
- If the message has no date or you are not confident, return {"event": null}.
- "summary" should be the concise apparent subject of the message (e.g. "Turnus", "Spotkanie"), not the whole body.
- "allDay" is true unless an explicit clock time is present in the message.
- All-day "start" and "end" are dates only: "YYYY-MM-DD". For a single-day event, set end = start.
- Timed "start" and "end" are local-naive: "YYYY-MM-DDTHH:mm". If no explicit end time was given, omit "end".
- For weekend phrases, use Saturday as start and Sunday as inclusive end.
- "end" is INCLUSIVE for all-day events (e.g. "14.05–16.05" → start=2026-05-14, end=2026-05-16).
- "location" and "description" are null if not present.

Schema:
{
  "event": null | {
    "summary": string,
    "allDay": boolean,
    "start": string,
    "end"?: string,
    "location": string | null,
    "description": string | null
  }
}

MESSAGE:
${input.body}`;
}

function addOneHourLocalNaive(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
  dt.setUTCHours(dt.getUTCHours() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
}

export function parseEventResponse(input: unknown): EventData | null {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) return null;
  const raw = parsed.data.event;
  if (raw === null) return null;
  if (raw.summary.trim() === '') return null;

  let end = raw.end;
  if (raw.allDay) {
    if (!DATE_ONLY.test(raw.start)) return null;
    if (end === undefined) end = raw.start;
    if (!DATE_ONLY.test(end)) return null;
  } else {
    if (!DATE_TIME.test(raw.start)) return null;
    if (end === undefined) end = addOneHourLocalNaive(raw.start);
    if (!DATE_TIME.test(end)) return null;
  }

  if (end < raw.start) return null;

  return {
    summary: raw.summary,
    allDay: raw.allDay,
    start: raw.start,
    end,
    location: raw.location,
    description: raw.description,
  };
}
```

### - [ ] Step 4: Run tests to verify they pass

Run: `npx vitest run tests/bot/event-prompt.test.ts`
Expected: all PASS.

### - [ ] Step 5: Run typecheck + lint

Run: `npm run typecheck && npm run lint`
Expected: green.

### - [ ] Step 6: Commit

```bash
git add src/bot/event-prompt.ts tests/bot/event-prompt.test.ts
git commit -m "feat(bot): event-prompt module (EventData type + prompt + parser)"
```

---

## Task 6: Install `ical-generator` + implement `ics-builder.ts`

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/bot/ics-builder.ts`
- Create: `tests/bot/ics-builder.test.ts`

### - [ ] Step 1: Install the dep

Run: `npm install ical-generator`
Expected: `package.json` lists `"ical-generator": "^X.Y.Z"` under `dependencies`.

### - [ ] Step 2: Write the failing tests

Create `tests/bot/ics-builder.test.ts`:

```ts
// tests/bot/ics-builder.test.ts
import { describe, expect, it } from 'vitest';
import type { EventData } from '../../src/bot/event-prompt';
import { buildIcs } from '../../src/bot/ics-builder';

const now = new Date('2026-05-19T09:00:00Z');

function build(overrides: Partial<EventData> = {}, opts: Partial<Parameters<typeof buildIcs>[0]> = {}) {
  const event: EventData = {
    summary: 'Turnus',
    allDay: true,
    start: '2026-05-14',
    end: '2026-05-14',
    location: null,
    description: null,
    ...overrides,
  };
  return buildIcs({
    event,
    timezone: 'Europe/Warsaw',
    organizerEmail: 'bot@example.com',
    attendeeEmail: 'me@example.com',
    now,
    chatId: 7,
    messageId: 1001,
    ...opts,
  });
}

describe('buildIcs', () => {
  it('filename and contentType', () => {
    const r = build();
    expect(r.filename).toBe('event.ics');
    expect(r.contentType).toBe('text/calendar; method=PUBLISH; charset=UTF-8');
  });

  it('uses CRLF line endings', () => {
    const ics = build().content.toString('utf8');
    expect(ics).toContain('\r\n');
    expect(ics.split('\n').filter((l) => l && !l.endsWith('\r')).length).toBe(0);
  });

  it('declares METHOD:PUBLISH', () => {
    const ics = build().content.toString('utf8');
    expect(ics).toContain('METHOD:PUBLISH');
  });

  it('all-day single day → DTSTART/DTEND date-only, end exclusive (+1 day)', () => {
    const ics = build({ allDay: true, start: '2026-05-14', end: '2026-05-14' }).content.toString('utf8');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260514');
    expect(ics).toContain('DTEND;VALUE=DATE:20260515');
  });

  it('all-day range "14.05–16.05" → DTEND=20260517 (inclusive→exclusive)', () => {
    const ics = build({ allDay: true, start: '2026-05-14', end: '2026-05-16' }).content.toString('utf8');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260514');
    expect(ics).toContain('DTEND;VALUE=DATE:20260517');
  });

  it('timed event uses TZID and emits VTIMEZONE block', () => {
    const ics = build({
      allDay: false,
      start: '2026-05-21T14:10',
      end: '2026-05-21T15:10',
    }).content.toString('utf8');
    expect(ics).toContain('TZID');
    expect(ics).toContain('Europe/Warsaw');
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(ics).toContain('END:VTIMEZONE');
  });

  it('escapes commas, semicolons, newlines, backslashes in SUMMARY', () => {
    const ics = build({ summary: 'A, B; C\nD\\E' }).content.toString('utf8');
    // RFC 5545 escaping: \, \; \n \\
    expect(ics).toMatch(/SUMMARY:[^\r\n]*A\\, B\\; C\\nD\\\\E/);
  });

  it('omits LOCATION when location is null', () => {
    const ics = build({ location: null }).content.toString('utf8');
    expect(ics).not.toContain('LOCATION:');
  });

  it('includes LOCATION when present', () => {
    const ics = build({ location: 'Warsaw, ul. Marszałkowska 1' }).content.toString('utf8');
    expect(ics).toContain('LOCATION:');
    expect(ics).toContain('Marsza');
  });

  it('UID is stable for same inputs', () => {
    const a = build().content.toString('utf8');
    const b = build().content.toString('utf8');
    const uidOf = (s: string) => /UID:([^\r\n]+)/.exec(s)?.[1];
    expect(uidOf(a)).toBe(uidOf(b));
  });

  it('UID differs when chatId or messageId differs', () => {
    const a = build({}, { chatId: 7, messageId: 1001 }).content.toString('utf8');
    const b = build({}, { chatId: 7, messageId: 1002 }).content.toString('utf8');
    const uidOf = (s: string) => /UID:([^\r\n]+)/.exec(s)?.[1];
    expect(uidOf(a)).not.toBe(uidOf(b));
  });

  it('UID ends with @telemach-bot', () => {
    const ics = build().content.toString('utf8');
    expect(ics).toMatch(/UID:[^\r\n]+@telemach-bot/);
  });

  it('long SUMMARY is folded at 75 octets per RFC 5545', () => {
    const long = 'x'.repeat(200);
    const ics = build({ summary: long }).content.toString('utf8');
    const lines = ics.split('\r\n');
    for (const line of lines) {
      // Continuation lines start with a space; folded line length ≤ 75 octets
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
  });
});
```

### - [ ] Step 3: Run tests to verify they fail

Run: `npx vitest run tests/bot/ics-builder.test.ts`
Expected: FAIL — `ics-builder` module not found.

### - [ ] Step 4: Implement `ics-builder.ts`

Create `src/bot/ics-builder.ts`:

```ts
// src/bot/ics-builder.ts
import { createHash } from 'node:crypto';
import ical, { ICalCalendarMethod } from 'ical-generator';
import type { EventData } from './event-prompt';

export interface IcsInput {
  event: EventData;
  timezone: string;
  organizerEmail: string;
  attendeeEmail: string;
  now: Date;
  chatId: number;
  messageId: number;
}

export interface IcsOutput {
  content: Buffer;
  filename: string;
  contentType: string;
}

function parseLocalNaive(iso: string, timezone: string): Date {
  // Build a Date that represents the wall-clock time in the given timezone.
  // We rely on ical-generator's `timezone` option to render with the correct TZID;
  // we just need a Date object whose UTC components equal the local wall clock.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(iso);
  if (!m) throw new Error(`invalid local-naive ISO: ${iso}`);
  const [, y, mo, d, h, mi] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? '0'), Number(mi ?? '0')));
}

function addOneDay(d: Date): Date {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + 1);
  return r;
}

function stableUid(input: IcsInput): string {
  const h = createHash('sha256');
  h.update(`${input.chatId}:${input.messageId}:${input.event.start}:${input.event.summary}`);
  return `${h.digest('hex').slice(0, 32)}@telemach-bot`;
}

export function buildIcs(input: IcsInput): IcsOutput {
  const cal = ical({
    prodId: { company: 'telemach-bot', product: 'telemach-bot', language: 'EN' },
    method: ICalCalendarMethod.PUBLISH,
    timezone: input.timezone,
  });

  const startWall = parseLocalNaive(input.event.start, input.timezone);
  let endWall = parseLocalNaive(input.event.end, input.timezone);
  if (input.event.allDay) {
    // Inclusive (contract) → exclusive (RFC 5545): add one day.
    endWall = addOneDay(endWall);
  }

  cal.createEvent({
    id: stableUid(input),
    start: startWall,
    end: endWall,
    allDay: input.event.allDay,
    summary: input.event.summary,
    description: input.event.description ?? undefined,
    location: input.event.location ?? undefined,
    stamp: input.now,
    timezone: input.event.allDay ? null : input.timezone,
  });

  const content = Buffer.from(cal.toString(), 'utf8');
  return {
    content,
    filename: 'event.ics',
    contentType: 'text/calendar; method=PUBLISH; charset=UTF-8',
  };
}
```

### - [ ] Step 5: Run tests to verify they pass

Run: `npx vitest run tests/bot/ics-builder.test.ts`
Expected: all PASS.

If any fail because of `ical-generator` API differences (option names, escaping, line folding), inspect the actual ICS output and adjust either the implementation (preferred) or the test assertion. Do not loosen tests on behavior the spec requires (CRLF, exclusive DTEND for all-day, stable UID, METHOD:PUBLISH).

### - [ ] Step 6: Run typecheck + lint

Run: `npm run typecheck && npm run lint`
Expected: green.

### - [ ] Step 7: Commit

```bash
git add package.json package-lock.json src/bot/ics-builder.ts tests/bot/ics-builder.test.ts
git commit -m "feat(bot): ics-builder produces RFC 5545 .ics via ical-generator"
```

---

## Task 7: `event-extraction` service (OpenRouter JSON-mode)

**Files:**
- Create: `src/services/event-extraction.ts`
- Create: `tests/services/event-extraction.test.ts`

### - [ ] Step 1: Write the failing tests

Create `tests/services/event-extraction.test.ts`:

```ts
// tests/services/event-extraction.test.ts
import { describe, expect, it, vi } from 'vitest';
import { makeEventExtractionClient } from '../../src/services/event-extraction';

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function chatResponseWith(content: string) {
  return { choices: [{ message: { content } }] };
}

const baseInput = {
  body: 'Spotkanie w czwartek o 14:10',
  nowInTz: '2026-05-19 09:00',
  timezone: 'Europe/Warsaw',
};

describe('event-extraction service', () => {
  it('returns EventData on a valid JSON response', async () => {
    const event = {
      summary: 'Spotkanie',
      allDay: false,
      start: '2026-05-21T14:10',
      end: '2026-05-21T15:10',
      location: null,
      description: null,
    };
    const fetchImpl = mockFetch(chatResponseWith(JSON.stringify({ event })));
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    const r = await client.extract(baseInput);
    expect(r).toEqual(event);
  });

  it('returns null when model returns {"event": null}', async () => {
    const fetchImpl = mockFetch(chatResponseWith(JSON.stringify({ event: null })));
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await client.extract(baseInput)).toBeNull();
  });

  it('returns null when model returns malformed JSON', async () => {
    const fetchImpl = mockFetch(chatResponseWith('not json'));
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await client.extract(baseInput)).toBeNull();
  });

  it('returns null when model returns JSON of wrong shape', async () => {
    const fetchImpl = mockFetch(chatResponseWith(JSON.stringify({ event: { summary: 'x' } })));
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await client.extract(baseInput)).toBeNull();
  });

  it('returns null on non-2xx', async () => {
    const fetchImpl = mockFetch({}, 500);
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await client.extract(baseInput)).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await client.extract(baseInput)).toBeNull();
  });

  it('sets response_format json_object in request body', async () => {
    const fetchImpl = mockFetch(chatResponseWith(JSON.stringify({ event: null })));
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    await client.extract(baseInput);
    const [, opts] = fetchImpl.mock.calls[0];
    const bodyJson = JSON.parse(opts.body);
    expect(bodyJson.response_format).toEqual({ type: 'json_object' });
    expect(bodyJson.model).toBe('m');
  });
});
```

### - [ ] Step 2: Run tests to verify they fail

Run: `npx vitest run tests/services/event-extraction.test.ts`
Expected: FAIL — service module not found.

### - [ ] Step 3: Implement the service

Create `src/services/event-extraction.ts`:

```ts
// src/services/event-extraction.ts
import { z } from 'zod';
import { buildEventPrompt, type EventData, parseEventResponse } from '../bot/event-prompt';
import { logger } from '../lib/logger';

export interface EventExtractionClient {
  extract(input: { body: string; nowInTz: string; timezone: string }): Promise<EventData | null>;
}

export interface EventExtractionOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

const chatSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
});

export function makeEventExtractionClient(opts: EventExtractionOptions): EventExtractionClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async extract(input) {
      try {
        const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: opts.model,
            messages: [{ role: 'user', content: buildEventPrompt(input) }],
            response_format: { type: 'json_object' },
            temperature: 0.1,
            max_tokens: 400,
          }),
        });
        if (!res.ok) {
          logger.warn({ status: res.status }, 'event-extraction: non-2xx');
          return null;
        }
        const json = await res.json();
        const parsed = chatSchema.safeParse(json);
        if (!parsed.success) {
          logger.warn({ json }, 'event-extraction: response shape unexpected');
          return null;
        }
        const content = parsed.data.choices[0]!.message.content;
        let obj: unknown;
        try {
          obj = JSON.parse(content);
        } catch {
          logger.warn({ content }, 'event-extraction: content not JSON');
          return null;
        }
        return parseEventResponse(obj);
      } catch (err) {
        logger.warn({ err }, 'event-extraction: call threw');
        return null;
      }
    },
  };
}
```

### - [ ] Step 4: Run tests to verify they pass

Run: `npx vitest run tests/services/event-extraction.test.ts`
Expected: all PASS.

### - [ ] Step 5: Run typecheck + lint

Run: `npm run typecheck && npm run lint`
Expected: green.

### - [ ] Step 6: Commit

```bash
git add src/services/event-extraction.ts tests/services/event-extraction.test.ts
git commit -m "feat(services): event-extraction (OpenRouter JSON-mode, null on failure)"
```

---

## Task 8: Config — `EVENT_MODEL` env var with fallback to `OPENROUTER_MODEL`

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

### - [ ] Step 1: Write the failing tests

Read `tests/config.test.ts` first to follow its pattern. Then append:

```ts
  it('EVENT_MODEL defaults to OPENROUTER_MODEL when unset', () => {
    const cfg = parseConfig({
      TELEGRAM_BOT_TOKEN: 'tg',
      ADMIN_TELEGRAM_USER_ID: '1',
      ADMIN_EMAIL: 'a@x.com',
      OPENROUTER_API_KEY: 'k',
      OPENROUTER_MODEL: 'special/model',
      RESEND_API_KEY: 'r',
      RESEND_FROM_EMAIL: 'b@x.com',
    });
    expect(cfg.eventModel).toBe('special/model');
  });

  it('EVENT_MODEL is used when set', () => {
    const cfg = parseConfig({
      TELEGRAM_BOT_TOKEN: 'tg',
      ADMIN_TELEGRAM_USER_ID: '1',
      ADMIN_EMAIL: 'a@x.com',
      OPENROUTER_API_KEY: 'k',
      OPENROUTER_MODEL: 'subject/m',
      EVENT_MODEL: 'event/m',
      RESEND_API_KEY: 'r',
      RESEND_FROM_EMAIL: 'b@x.com',
    });
    expect(cfg.eventModel).toBe('event/m');
  });
```

### - [ ] Step 2: Run tests to verify they fail

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `cfg.eventModel` undefined.

### - [ ] Step 3: Add `EVENT_MODEL` to config

Edit `src/config.ts`:

a) Add to the zod schema (anywhere alongside `OPENROUTER_MODEL`):

```ts
  EVENT_MODEL: z.string().optional(),
```

b) Add to the `Config` interface:

```ts
  eventModel: string;
```

c) Add to the return object inside `parseConfig`:

```ts
    eventModel: e.EVENT_MODEL ?? e.OPENROUTER_MODEL,
```

### - [ ] Step 4: Run tests to verify they pass

Run: `npx vitest run tests/config.test.ts`
Expected: all PASS.

### - [ ] Step 5: Run typecheck + lint

Run: `npm run typecheck && npm run lint`
Expected: green.

### - [ ] Step 6: Commit

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): EVENT_MODEL env var with fallback to OPENROUTER_MODEL"
```

---

## Task 9: Wire event extraction + ics into the forward pipeline

**Files:**
- Modify: `src/bot/forward.ts`
- Modify: `src/bot/index.ts`
- Modify: `tests/bot/forward.test.ts`

### - [ ] Step 1: Write the failing tests

Read `tests/bot/forward.test.ts` first to follow its patterns. Append to the existing `describe('forward handler', …)` block:

```ts
  it('attaches .ics and appends body note when extraction returns an event', async () => {
    const event = {
      summary: 'Spotkanie',
      allDay: false,
      start: '2026-05-21T14:10',
      end: '2026-05-21T15:10',
      location: null,
      description: null,
    };
    const events = { extract: vi.fn().mockResolvedValue(event) };
    const { deps, repo } = makeDeps({ events });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'Spotkanie w czwartek o 14:10' });
    await handler(ctx as any);

    const payload = deps.resend.send.mock.calls[0][0];
    const ics = payload.attachments.find((a: any) => a.filename === 'event.ics');
    expect(ics).toBeTruthy();
    expect(ics.contentType).toBe('text/calendar; method=PUBLISH; charset=UTF-8');
    expect(payload.text).toContain('📅 Event attached:');
    expect(payload.text).toContain('Spotkanie');

    const events_audit = repo
      .db.prepare(`SELECT event FROM audit_log WHERE telegram_id = ? ORDER BY id`)
      .all(7) as { event: string }[];
    const types = events_audit.map((r) => r.event);
    expect(types).toContain('event_extracted');
    expect(types).toContain('event_attached');

    const reactionsCalled = ctx.react.mock.calls.map((c) => c[0]);
    expect(reactionsCalled).toContain('📅');
    expect(reactionsCalled).toContain('👍');
  });

  it('no .ics, no body note, no event audit when extraction returns null', async () => {
    const events = { extract: vi.fn().mockResolvedValue(null) };
    const { deps, repo } = makeDeps({ events });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'random no-date message' });
    await handler(ctx as any);

    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.attachments).toEqual([]);
    expect(payload.text).not.toContain('📅');

    const types = (
      repo.db.prepare(`SELECT event FROM audit_log WHERE telegram_id = ?`).all(7) as {
        event: string;
      }[]
    ).map((r) => r.event);
    expect(types).not.toContain('event_extracted');
    expect(types).not.toContain('event_attached');
  });

  it('extraction that throws degrades to no .ics, email still sends', async () => {
    const events = { extract: vi.fn().mockRejectedValue(new Error('boom')) };
    const { deps } = makeDeps({ events });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'anything' });
    await handler(ctx as any);

    expect(deps.resend.send).toHaveBeenCalledTimes(1);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.attachments).toEqual([]);
  });

  it('voice transcript body is scanned for events', async () => {
    const event = {
      summary: 'Turnus',
      allDay: true,
      start: '2026-05-14',
      end: '2026-05-16',
      location: null,
      description: null,
    };
    const events = { extract: vi.fn().mockResolvedValue(event) };
    const { deps } = makeDeps({ events });
    deps.transcription.transcribe.mockResolvedValue('Turnus 14.05 - 16.05');
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({
      voice: { file_id: 'vf', file_unique_id: 'u', duration: 3 } as any,
    });
    await handler(ctx as any);

    expect(events.extract).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Turnus 14.05 - 16.05' }),
    );
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.attachments.some((a: any) => a.filename === 'event.ics')).toBe(true);
  });

  it('uses the timezone captured at receive-time even if user changes it later (media-group)', async () => {
    const event = {
      summary: 'X',
      allDay: true,
      start: '2026-05-14',
      end: '2026-05-14',
      location: null,
      description: null,
    };
    const extract = vi.fn().mockResolvedValue(event);
    const { deps, repo } = makeDeps({
      events: { extract },
      mediaGroupFlushMs: 5,
    });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({
      text: '',
      caption: 'Turnus 14.05',
      media_group_id: 'g1',
      photo: [
        { file_id: 'p1', file_unique_id: '1', width: 10, height: 10, file_size: 10 },
      ] as any,
    });
    await handler(ctx as any);
    // change timezone after enqueue
    repo.updateTimezone(7, 'America/New_York');
    await new Promise((r) => setTimeout(r, 20));

    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: 'Europe/Warsaw' }),
    );
  });
```

Also update the `makeDeps` helper at the top of the file to accept an `events` mock and a default mock that returns `null`:

```ts
function makeDeps(overrides: Partial<any> = {}) {
  const repo = new UserRepo(makeTempDb());
  repo.upsertNew({ telegramId: 7, username: 'alice', firstName: 'Alice' });
  repo.setEmail(7, 'alice@x.com');
  repo.setStatus(7, 'APPROVED');
  const deps = {
    repo,
    fromEmail: 'bot@x.com',
    subject: { generateSubject: vi.fn().mockResolvedValue('Lunch plans') },
    transcription: { transcribe: vi.fn().mockResolvedValue('hello voice') },
    events: { extract: vi.fn().mockResolvedValue(null) },
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
```

The existing tests in this file already pass `subject`, `transcription`, etc. — adding `events` to the default makes them backward-compatible (extraction returns null → no behavior change for them).

Expose the underlying DB from `UserRepo` for tests by adding a getter — OR, simpler, query `db` directly via a fresh prepare on the same `:memory:` handle. The simpler path: capture the `db` from `makeTempDb()` and use it directly:

If `repo.db` isn't accessible (it's `private`), restructure the helper to also return the db handle:

```ts
function makeDeps(overrides: Partial<any> = {}) {
  const db = makeTempDb();
  const repo = new UserRepo(db);
  // ... rest unchanged ...
  return { deps, repo, db };
}
```

…and have the new tests destructure `db` rather than `repo.db`. Adjust the test snippets above accordingly when implementing.

### - [ ] Step 2: Run tests to verify they fail

Run: `npx vitest run tests/bot/forward.test.ts`
Expected: new tests FAIL (events dep not consumed, no ics attached, no body note, no new audit rows, no 📅 reaction).

### - [ ] Step 3: Extend `ForwardDeps` and `PersistedPayload`, add `tryOrNull` helper

Edit `src/bot/forward.ts`:

a) Add the `events` dependency to `ForwardDeps`:

```ts
import type { EventExtractionClient } from '../services/event-extraction';
import { buildIcs } from './ics-builder';

export interface ForwardDeps {
  repo: UserRepo;
  fromEmail: string;
  botToken: string;
  api: Api;
  subject: SubjectClient;
  transcription: TranscriptionClient;
  events: EventExtractionClient;
  resend: ResendSender;
  download: (input: { api: Api; botToken: string; fileId: string }) => Promise<{
    buffer: Buffer;
    filename: string;
    mimeType: string | null;
  }>;
  mediaGroupFlushMs: number;
  retryDelays: number[];
}
```

b) Extend `PersistedPayload` to include `timezone`:

```ts
interface PersistedPayload {
  kind: MsgKind;
  user: { email: string; username: string | null; firstName: string | null; telegramId: number };
  timezone: string;
}
```

c) Add `tryOrNull` and `formatNowInTz` helpers near the top of the module (outside `makeForwardHandler`):

```ts
async function tryOrNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err }, 'tryOrNull caught (degraded to null)');
    return null;
  }
}

function formatNowInTz(d: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function formatEventNote(event: import('./event-prompt').EventData, timezone: string): string {
  const fmtFull = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const fmtDay = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
  });
  const fmtTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const startDate = new Date(`${event.start}Z`);
  const endDate = new Date(`${event.end}Z`);
  if (event.allDay) {
    if (event.start === event.end) {
      return `📅 Event attached: ${event.summary}, ${fmtFull.format(startDate)}`;
    }
    return `📅 Event attached: ${event.summary}, ${fmtDay.format(startDate)}–${fmtDay.format(endDate)} ${startDate.getUTCFullYear()}`;
  }
  return `📅 Event attached: ${event.summary}, ${fmtFull.format(startDate)}, ${fmtTime.format(startDate)}–${fmtTime.format(endDate)} (${timezone})`;
}
```

Note: passing the local-naive ISO with a `Z` suffix means `Intl.DateTimeFormat` with `timeZone: timezone` re-interprets the date — but for display purposes (day/month/year/weekday match the local-naive components) this is acceptable for all-day and same-day timed events. If a future test reveals an off-by-one near midnight, switch to a parser that splits the string and formats manually.

d) Add `markEventAttached` to the imports:

```ts
import { markDone, markEventAttached, markFailed, markReceived, markWorking } from './reactions';
```

### - [ ] Step 4: Modify `buildAndSend` to extract, attach, note, and audit

Replace the body of `buildAndSend` (the part after assembling `body`, `attachments`, `captions`) with:

```ts
    const body = transcribedBody ?? captions.join('\n\n');
    const subjectInput =
      body || (attachments.length > 0 ? attachmentCountLabel(attachments.length) : '(no text)');

    const userTz = first.payload.timezone;
    const nowInTz = formatNowInTz(new Date(), userTz);

    const [rawSubject, event] = await Promise.all([
      tryOrNull(() => deps.subject.generateSubject(subjectInput)),
      body
        ? tryOrNull(() => deps.events.extract({ body, nowInTz, timezone: userTz }))
        : Promise.resolve(null),
    ]);

    const subject = rawSubject
      ? sanitizeSubject(rawSubject) || fallbackSubject(first.payload.user.username)
      : fallbackSubject(first.payload.user.username);

    let bodyForEmail = body;
    let eventAttached = false;
    if (event) {
      deps.repo.logAudit({
        telegramId: first.telegramId,
        chatMessageId: first.messageId,
        event: 'event_extracted',
        details: JSON.stringify({
          summary: event.summary,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
        }),
      });
      try {
        const ics = buildIcs({
          event,
          timezone: userTz,
          organizerEmail: deps.fromEmail,
          attendeeEmail: first.payload.user.email,
          now: new Date(),
          chatId: first.chatId,
          messageId: first.messageId,
        });
        attachments.push({
          filename: ics.filename,
          content: ics.content,
          contentType: ics.contentType,
        });
        const note = formatEventNote(event, userTz);
        bodyForEmail = body ? `${body}\n\n${note}` : note;
        eventAttached = true;
      } catch (err) {
        logger.error({ err }, 'ics-builder failed; email will send without .ics');
      }
    }

    const payload = composeEmail({
      fromEmail: deps.fromEmail,
      toEmail: first.payload.user.email,
      username: first.payload.user.username,
      firstName: first.payload.user.firstName,
      telegramId: first.payload.user.telegramId,
      subject,
      body: bodyForEmail,
      attachments,
      sentAt: new Date(),
    });
    await withRetry(() => deps.resend.send(payload), { delaysMs: deps.retryDelays });

    const groupDetails =
      items.length > 1 ? JSON.stringify({ group: items.length, attachments: attachments.length }) : null;
    for (const it of items) {
      deps.repo.logAudit({
        telegramId: it.telegramId,
        chatMessageId: it.messageId,
        event: 'emailed',
        details: groupDetails,
      });
    }

    if (eventAttached) {
      deps.repo.logAudit({
        telegramId: first.telegramId,
        chatMessageId: first.messageId,
        event: 'event_attached',
        details: JSON.stringify({
          summary: event!.summary,
          start: event!.start,
          end: event!.end,
          allDay: event!.allDay,
        }),
      });
    }
  }
```

### - [ ] Step 5: Populate `timezone` in `PersistedPayload` at receive-time

In the handler body (`const handler: ForwardHandler = async (ctx) => …`), update the `payload` construction:

```ts
    const payload: PersistedPayload = {
      kind,
      user: {
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        telegramId: user.telegramId,
      },
      timezone: user.timezone,
    };
```

### - [ ] Step 6: Defensive fallback in `replayPending` for pre-v1.1 payloads

In `replayPending`, after `const payload = JSON.parse(r.payloadJson) as PersistedPayload;`, add:

```ts
          if (typeof payload.timezone !== 'string') payload.timezone = 'Europe/Warsaw';
```

### - [ ] Step 7: Add `markEventAttached` call after `markDone`

In `processGroup`, after the `for (const it of items) await reactDone(it, deps.api);` line, add (you'll need a flag passed back from `buildAndSend` — refactor `buildAndSend` to return `{ eventAttached: boolean }`):

```ts
      const result = await buildAndSend(items);
      for (const it of items) await reactDone(it, deps.api);
      if (result.eventAttached) {
        for (const it of items) {
          if (it.ctx) await markEventAttached(it.ctx);
          else await safeApiReact(deps.api, it.chatId, it.messageId, '📅');
        }
      }
```

And in the non-group handler path, after `markDone(ctx)`:

```ts
      const result = await buildAndSend([item]);
      await markDone(ctx);
      if (result.eventAttached) await markEventAttached(ctx);
```

Change `buildAndSend` signature to return the flag:

```ts
async function buildAndSend(items: WorkItem[]): Promise<{ eventAttached: boolean }> {
  // ... existing body ...
  return { eventAttached };
}
```

(Initialize `eventAttached = false` at the top of the function with the other variables.)

### - [ ] Step 8: Wire the new dependency in `src/bot/index.ts`

Edit `src/bot/index.ts`:

a) Import the factory:

```ts
import { makeEventExtractionClient } from '../services/event-extraction';
```

b) Construct it alongside the other clients (after `subject`):

```ts
  const events = makeEventExtractionClient({
    apiKey: config.openrouterApiKey,
    model: config.eventModel,
  });
```

c) Pass it to `makeForwardHandler`:

```ts
  const forward = makeForwardHandler({
    repo,
    fromEmail: config.resendFromEmail,
    botToken: config.telegramBotToken,
    api: bot.api,
    subject,
    transcription,
    events,
    resend,
    download: ({ api, botToken, fileId }) => downloadTelegramFile({ api, botToken, fileId }),
    mediaGroupFlushMs: config.mediaGroupFlushMs,
    retryDelays: [500, 2000, 8000],
  });
```

### - [ ] Step 9: Run tests to verify they pass

Run: `npx vitest run tests/bot/forward.test.ts`
Expected: all PASS, including the 5 new tests.

### - [ ] Step 10: Run full suite + typecheck + lint

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

### - [ ] Step 11: Build

Run: `npm run build`
Expected: clean compile; `dist/` populated.

### - [ ] Step 12: Commit

```bash
git add src/bot/forward.ts src/bot/index.ts tests/bot/forward.test.ts
git commit -m "feat(bot): extract event from messages and attach .ics to email"
```

---

## Final verification

### - [ ] Step 1: Full QA

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green.

### - [ ] Step 2: Sanity-check git log

Run: `git log --oneline origin/main..HEAD`
Expected: roughly 9 conventional commits in this order:
1. `feat(db): add users.timezone column with idempotent migration`
2. `feat(bot): /timezone command (set/get user IANA timezone)`
3. `feat(bot): add 📅 reaction (markEventAttached)`
4. `feat(bot): EmailAttachment supports optional contentType`
5. `feat(bot): event-prompt module (EventData type + prompt + parser)`
6. `feat(bot): ics-builder produces RFC 5545 .ics via ical-generator`
7. `feat(services): event-extraction (OpenRouter JSON-mode, null on failure)`
8. `feat(config): EVENT_MODEL env var with fallback to OPENROUTER_MODEL`
9. `feat(bot): extract event from messages and attach .ics to email`

### - [ ] Step 3: Manual smoke notes for after deploy

The first deploy is the first real integration test (per the base spec's stance). On first message after deploy, verify in the inbox:
- Email arrives with the same content as today.
- `.ics` attachment present when a date is in the message.
- Gmail / Apple Mail show an "Add to Calendar" affordance on the .ics.
- 📅 reaction appears on the Telegram message (replacing or supplementing 👍 depending on premium status).
- `/timezone` (no arg) returns `Europe/Warsaw`. Set a different timezone and verify the next event's wall-clock matches.
