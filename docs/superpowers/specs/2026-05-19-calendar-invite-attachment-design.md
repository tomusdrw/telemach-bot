# Calendar Invite Attachment — Design

**Status:** Draft
**Date:** 2026-05-19
**Owner:** @tomusdrw
**Tracks:** v1.1 of telemach-bot (see `2026-05-18-telegram-email-bot-design.md` for the base system)

## Purpose

When a forwarded Telegram message describes an event (a date, optionally a time, optionally a location), attach an `.ics` calendar file to the outgoing email so the recipient can add it to their calendar in one click. The email body is unchanged except for a small "📅 Event attached: …" note appended at the end. If no event is detected — or the LLM is not confident — the email goes out exactly as it does today.

Calendar attachments are **informational** (`METHOD:PUBLISH`), not RSVP invites. The bot sends from a Resend no-reply address that cannot receive replies, so a true `METHOD:REQUEST` invite would mislead clients into showing accept/decline buttons that don't work.

## Goals

- Extract one event per message, when present, with a single LLM call (OpenRouter, JSON-mode).
- Attach a valid RFC 5545 `.ics` so Gmail / Apple Mail / Outlook surface an "Add to Calendar" affordance directly.
- Per-user timezone, configurable via Telegram command, default `Europe/Warsaw`.
- All-day by default; timed when an explicit clock time is given.
- Spurious extractions are acceptable; missed extractions are acceptable. Failures must never block the email.
- No change to existing 102 unit tests except where they intersect a modified module.

## Non-goals (v1.1)

- Multiple events per message — first/most-prominent only.
- RSVP / true invites (`METHOD:REQUEST`).
- Editing the calendar event when the source Telegram message is edited (consistent with the base spec's "no edited-message re-send").
- Event extraction from images (no OCR).
- A heuristic for guessing the user's timezone from Telegram language/locale.
- Recurring events (`RRULE`). v1.1 emits single-instance events only.
- A confidence *score*; confidence is encoded as "the LLM returns null when unsure".

## High-level flow

```
forward handler
   │
   ├─ classify message (existing)
   ├─ download & transcribe (existing)
   ├─ assemble body (existing)
   │
   ├─► Promise.all([
   │     subject.generateSubject(body),                                 ◄── existing
   │     eventExtraction.extract({ body, timezone, nowInTz }),          ◄── NEW
   │   ])
   │
   │   if event ≠ null:
   │     ics = buildIcs({ event, timezone, organizerEmail, attendeeEmail, now })
   │     attachments.push({ filename: 'event.ics', content: ics, contentType: '…' })
   │     body += "\n\n📅 Event attached: …"
   │
   ├─► composeEmail(...)
   ├─► resend.send(payload)
   └─► reactions: markDone (+ markEventAttached if event ≠ null)
       audit:     event_extracted (if non-null), event_attached (if attached)
```

Event extraction and subject generation are both no-throw / null-on-failure. They run in parallel; neither blocks the other or the email.

## File layout

```
src/
├── bot/
│   ├── ics-builder.ts        # NEW — pure: EventData + timezone → RFC 5545 string
│   ├── event-prompt.ts       # NEW — pure: prompt builder + zod schema for parsing
│   ├── timezone-cmd.ts       # NEW — /timezone command handler
│   ├── reactions.ts          # MODIFIED — add 📅 to known emoji set + markEventAttached
│   ├── email-composer.ts     # MODIFIED — EmailAttachment gains optional contentType
│   ├── forward.ts            # MODIFIED — integrate extraction + ics into buildAndSend
│   └── index.ts              # MODIFIED — wire /timezone command
├── services/
│   └── event-extraction.ts   # NEW — OpenRouter call, returns EventData | null
├── db/
│   ├── schema.sql            # MODIFIED — add timezone column to users
│   ├── index.ts              # MODIFIED — PRAGMA table_info check + ALTER for existing DBs
│   └── users.ts              # MODIFIED — updateTimezone, findById returns timezone
```

## Data model

### `EventData`

The extraction service returns this shape on success, or `null` otherwise:

```ts
export interface EventData {
  summary: string;            // event title, e.g. "Turnus"
  allDay: boolean;            // true unless an explicit clock time was given
  start: string;              // "2026-05-14" (all-day) or "2026-05-14T14:10" (timed)
  end:   string;              // same format; INCLUSIVE last day for all-day events
  location: string | null;
  description: string | null; // any extra detail beyond title, else null
}
```

Design decisions:

- **Local-naive ISO strings.** No `Z`, no offset. The LLM is told to interpret all times in the user's `timezone`; the ics-builder converts to `TZID`-tagged values (or `VALUE=DATE` for all-day).
- **`end` is INCLUSIVE** at the contract boundary because that's how humans say it ("14.05–16.05" = three days). The ics-builder converts to RFC 5545's exclusive `DTEND` (`20260517` for the same range). Keeping inclusive at the boundary makes the LLM less likely to silently off-by-one us.
- **`null` for unsure.** No confidence score. The prompt instructs the LLM to return `{"event": null}` if it cannot identify a date with reasonable confidence. Single null path = single fallback.

### `users.timezone`

New column:

```sql
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw';
```

- Stored as IANA string (e.g. `Europe/Warsaw`, `America/New_York`).
- Validated on write only (`new Intl.DateTimeFormat('en-US', { timeZone: tz })` throws on unknown names).
- Reads trust the DB.
- Migration: the schema file is updated (so fresh DBs get the column at create time). For existing DBs, `openDatabase` gains a `PRAGMA table_info('users')` check that runs after the schema bootstrap; if `timezone` is absent the `ALTER TABLE` is applied. This preserves the existing "idempotent bootstrap, no migration runner" pattern.

### `PersistedPayload.timezone`

`forward.ts`'s `PersistedPayload` (serialized into `media_group_pending.payload_json`) gains a `timezone` field. Captured at receive-time so a `/timezone` change between receipt and replay does not retroactively rewrite an in-flight event. Replayed rows from before v1.1 that lack the field fall back to `'Europe/Warsaw'`.

## Components

### `src/services/event-extraction.ts`

```ts
export interface EventExtractionClient {
  extract(input: { body: string; nowInTz: string; timezone: string }): Promise<EventData | null>;
}

export interface EventExtractionOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export function makeEventExtractionClient(opts: EventExtractionOptions): EventExtractionClient;
```

- POSTs to `https://openrouter.ai/api/v1/chat/completions` with `response_format: { type: 'json_object' }`.
- Same model as subject generation by default (configurable separately via `EVENT_MODEL` env var; falls back to `SUBJECT_MODEL` if unset).
- Validates response with a zod schema discriminated on `event: null | EventData`.
- Returns `null` on: invalid JSON, schema mismatch, `end < start`, empty `summary`, non-2xx status, fetch throwing.
- Logs warnings (not errors) on all failure paths. Never throws.

### `src/bot/event-prompt.ts`

Pure module. Exports:

- `buildEventPrompt({ body, nowInTz, timezone })` — string prompt instructing the LLM to:
  - Treat all extracted times as local to `timezone`.
  - Resolve relative dates (`tomorrow`, `next weekend`, `w czwartek`) relative to `nowInTz`.
  - Default to `allDay: true` unless an explicit clock time appears.
  - Set `end = start` for single-day all-day events.
  - For weekend phrases, use Saturday as start and Sunday as inclusive end.
  - For timed events with no explicit end, omit `end` (the schema then fills it as start + 1h).
  - Return `{"event": null}` when unsure or when no date is present.
  - Keep `summary` concise (the message's apparent subject; not the whole body).
- `parseEventResponse(json: unknown): EventData | null` — zod-validated parsing with the post-conditions above (`end < start` → null, empty summary → null, 1-hour default for missing timed end).

### `src/bot/ics-builder.ts`

```ts
export interface IcsInput {
  event: EventData;
  timezone: string;
  organizerEmail: string;  // = fromEmail
  attendeeEmail: string;   // = user.email
  now: Date;               // for DTSTAMP + deterministic UID input
  chatId: number;          // for stable UID
  messageId: number;       // for stable UID
}

export interface IcsOutput {
  content: Buffer;
  filename: string;        // always 'event.ics'
  contentType: string;     // 'text/calendar; method=PUBLISH; charset=UTF-8'
}

export function buildIcs(input: IcsInput): IcsOutput;
```

Implementation uses the `ical-generator` npm package (MIT, ~30KB, no native deps). It handles VTIMEZONE generation for arbitrary IANA zones, line folding, escaping, and DST. We configure it with `method: 'publish'` and one event per call.

UID is deterministic: `sha256(chatId + ':' + messageId + ':' + start + ':' + summary) + '@telemach-bot'`. Stable so a startup replay of the same message produces an identical UID, allowing calendar clients to de-duplicate rather than create a second event.

All-day handling: when `event.allDay === true`, the builder sets `allDay: true` on the ical-generator event and converts the inclusive `end` to exclusive by adding one day. `ical-generator`'s `end` for all-day events is exclusive per RFC 5545, matching the spec.

### `src/bot/timezone-cmd.ts`

Command handler for `/timezone`. Available only to APPROVED users (direct guard in the handler — no new action type in `auth.ts`).

| Input | Effect | Reply |
| --- | --- | --- |
| `/timezone` | none | `Your timezone: Europe/Warsaw` |
| `/timezone Europe/London` | `updateTimezone(...)`; audit | `Timezone updated: Europe/London` |
| `/timezone Foo/Bar` | none | `Unknown timezone. Use an IANA name like 'Europe/Warsaw' or 'America/New_York'.` |
| (non-approved user) | none | (no reply — same as other commands for non-approved users) |

Audit row on change: `event='timezone_changed', details=JSON.stringify({from, to})`.

### `src/bot/reactions.ts`

Add `📅` to the known-emoji union. Add `markEventAttached(ctx)` that sets the 📅 reaction. Called from `forward.ts` after `markDone` when an event was attached.

Telegram allows multiple reactions per message only for premium users. For non-premium accounts, setting 📅 will *replace* 👍. The body note "📅 Event attached: …" plus actual inbox arrival remain as success signals, so this trade-off is acceptable.

### `src/bot/email-composer.ts`

`EmailAttachment` gains an optional `contentType?: string`. When present, the Resend payload's attachment entry carries it through. Existing call sites that don't set `contentType` are unaffected (Resend infers from filename).

### `src/bot/forward.ts`

Changes to `buildAndSend`:

1. After body assembly, run `Promise.all([generateSubject(body), extract({ body, timezone, nowInTz })])`. `nowInTz` is computed by formatting `new Date()` in the user's timezone as `YYYY-MM-DD HH:mm`. Although both services document a no-throw contract, the extraction and builder calls are wrapped in a thin `tryOrNull` helper at the call site so that a contract violation degrades to "no event attached" rather than failing the email. Without the wrapper, a rejection from `extract` would propagate through `Promise.all` and drop the subject as well.
2. If `extract` returned a non-null `event`:
   - Build the .ics via `buildIcs`.
   - Append the .ics to `attachments` with its `contentType`.
   - Append the human-readable note to `body` (see "Body note format" below).
   - Audit `event_extracted` with `details = JSON.stringify({summary, start, end, allDay})`.
   - After successful send, audit `event_attached` (separate row so a hypothetical builder failure remains visible).
3. After successful send, if event attached, call `markEventAttached(ctx)` in addition to `markDone`.

`PersistedPayload` gains `timezone` (captured at receive-time as described in Data model).

### Body note format

Plain text appended to `body` after a blank line. Examples:

- All-day single day: `📅 Event attached: Spotkanie, Thursday 14 May 2026`
- All-day range: `📅 Event attached: Turnus, 14–16 May 2026`
- Timed: `📅 Event attached: Spotkanie, Thursday 14 May 2026, 14:10–15:10 (Europe/Warsaw)`

Dates are formatted via `Intl.DateTimeFormat` in the user's timezone. The HTML branch of `composeEmail` already escapes everything, so no special handling needed there.

## Error handling

| Failure | Behavior |
| --- | --- |
| Extraction returns null (no event, low confidence, fetch failed, parse failed) | Email sends as today. No .ics. No body note. No 📅 reaction. No event audit rows. |
| Builder throws (defensive — shouldn't happen with typed input) | Logged at `error`. Email sends without .ics. No body note. `event_extracted` row was written by step 2; no `event_attached` row. |
| `composeEmail` / `resend.send` throws | Existing 💩 path. Event audit rows present (if any) but no `event_attached`. |
| `/timezone` validation fails | Reply with usage hint. No DB write. No audit row. |
| `/timezone` DB write throws (disk full, etc.) | Existing top-level error path; reply with generic failure. |

## Audit events (additions)

| event | details JSON | Written when |
| --- | --- | --- |
| `event_extracted` | `{summary, start, end, allDay}` | Extraction returned non-null |
| `event_attached` | `{summary, start, end, allDay}` | .ics was in the sent email |
| `timezone_changed` | `{from, to}` | `/timezone` successfully updated the DB |

## Testing

Pattern matches the rest of the codebase: pure modules unit-tested directly; service wrappers mocked at the SDK boundary (`fetch`); handler-level tests use the existing fake-ctx helper.

### New test files

- `tests/bot/ics-builder.test.ts`
  - All-day single day → DTSTART/DTEND exclusive (`14.05` → DTSTART=20260514, DTEND=20260515)
  - All-day range → inclusive→exclusive conversion (`14.05–16.05` → DTEND=20260517)
  - Timed event → `TZID=Europe/Warsaw` present, VTIMEZONE block included
  - RFC 5545 escaping (`,`, `;`, `\n`, `\\` in summary/description/location)
  - Line folding at 75 octets
  - Stable UID from same inputs; different UID when chatId/messageId differs
  - `location: null` → no LOCATION line
  - CRLF line endings
  - `contentType` and `filename` returned correctly

- `tests/bot/event-prompt.test.ts`
  - Prompt includes `nowInTz` and `timezone` verbatim
  - Schema accepts the canonical examples ("14.05–16.05 Turnus", "Trzcisko w przyszły weekend", "Spotkanie w czwartek o 14:10")
  - `end < start` → null
  - Empty `summary` → null
  - Missing timed `end` → filled to `start + 1h`
  - `{"event": null}` → null

- `tests/services/event-extraction.test.ts`
  - 2xx with valid JSON → returns EventData
  - 2xx with invalid JSON shape → returns null, logs warn
  - 2xx with `{"event": null}` → returns null, no warn
  - Non-2xx → returns null, logs warn
  - fetch throws → returns null, logs warn
  - Request body includes `response_format: { type: 'json_object' }`

- `tests/bot/timezone-cmd.test.ts`
  - `/timezone` (no arg) replies with current
  - `/timezone Europe/London` validates, calls `updateTimezone`, replies success, writes audit row
  - `/timezone Foo/Bar` rejects, no DB write, no audit row
  - Non-approved user → no reply, no write

### Modified test files

- `tests/bot/forward.test.ts`
  - Extraction returns null → no .ics, no body note, no 📅, no event audit rows, normal email sent
  - Extraction returns event → .ics in attachments with correct `contentType`, body note appended, `event_extracted` + `event_attached` rows present, 📅 reaction set after 👍
  - Extraction throws (defensive) → email still sends, no .ics
  - Builder throws (defensive) → email still sends, `event_extracted` present, `event_attached` absent
  - Media-group flow: timezone captured at receive-time persists across replay (set tz, enqueue, change tz via repo, flush → ics uses the original)
  - Voice-transcript body is scanned for events

- `tests/bot/email-composer.test.ts`
  - Attachment with `contentType` field is preserved in the Resend payload
  - Attachment without `contentType` works as today

- `tests/db/users.test.ts`
  - `updateTimezone` happy path
  - Existing rows without the column pick up the default after migration
  - `PRAGMA table_info` check is idempotent (running `openDatabase` twice doesn't fail)

Real provider tests remain out of CI, consistent with the base spec.

## Dependencies

| Package | Reason | Size | License |
| --- | --- | --- | --- |
| `ical-generator` | RFC 5545 output with proper VTIMEZONE handling and DST | ~30KB | MIT |

No native deps. Validated via a smoke test in `tests/bot/ics-builder.test.ts`.

## Environment variables (additions)

| Var | Default | Purpose |
| --- | --- | --- |
| `EVENT_MODEL` | falls back to `SUBJECT_MODEL` | OpenRouter model for event extraction |

No new secrets — reuses `OPENROUTER_API_KEY`.

## Rollout

- The `users.timezone` migration is additive with a safe default. No downtime.
- A first-message-after-deploy from an existing user defaults to `Europe/Warsaw` until they run `/timezone`. Consistent with the user's accepted trade-off ("spurious invites are fine").
- The `EVENT_MODEL` var is optional; if unset, extraction reuses `SUBJECT_MODEL`. Deploy can ship without env changes.

## Open questions

None at design time. Any model-quality questions (which IANA zones are reliably resolved, which Polish/English date phrases work best) will surface during the first week of real use and can be addressed with prompt tweaks.
