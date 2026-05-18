# CLAUDE.md — telemach-bot

Personal Telegram bot that forwards messages and voice transcripts to email. Single Node 22 / TypeScript process, long-polling against Telegram, SQLite for state, Resend for email, OpenAI Whisper for voice, OpenRouter for subject generation. Runs in one Docker container with a bind-mounted `/data` volume.

## Where things live

```
src/
├── index.ts                # entry: load config, init db, start bot
├── config.ts               # zod-validated env parsing
├── lib/{errors,logger}.ts  # TransientError/FatalError + withRetry; pino
├── db/                     # SQLite (better-sqlite3); schema bootstrapped on connect
└── bot/
    ├── index.ts            # grammy wiring (commands, callback queries, message handler)
    ├── auth.ts             # decideAction(user, input) → typed Action union
    ├── reactions.ts        # markReceived/Working/Done/Failed (👀 ✍ 👍 💩)
    ├── media-group.ts      # in-memory debounce buffer keyed by media_group_id
    ├── email-composer.ts   # pure: builds the Resend payload
    ├── subject-prompt.ts   # pure: prompt + sanitize + fallback
    ├── onboarding.ts       # /start, /register, plain-message gate
    ├── admin.ts            # approve/reject DM + callback handlers
    └── forward.ts          # main orchestration: classify → download → (whisper|attach) → subject → send
└── services/
    ├── telegram-files.ts   # getFile + CDN download, 20MB cap
    ├── whisper.ts          # OpenAI Whisper
    ├── subject.ts          # OpenRouter (single attempt, null on failure)
    └── resend.ts           # Resend email send
tests/                      # mirrors src/, plus tests/helpers/{temp-db,fake-ctx}.ts
docs/superpowers/
├── specs/2026-05-18-telegram-email-bot-design.md   # the source of truth
└── plans/2026-05-18-telegram-email-bot.md          # how it was built
```

Read the spec before changing behavior. Read the plan if you need to understand *why* a thing is split the way it is.

## Conventions

- **TDD by default.** Pure modules and service wrappers should have failing tests first, then implementation.
- **Conventional commit messages** with scope: `feat(bot):`, `feat(services):`, `feat(db):`, `feat(lib):`, `chore:`, `build:`, `docs:`.
- **GPG signing is on.** Commits prompt for a YubiKey tap. If a commit hangs at `gpg failed: Operation cancelled`, the user needs to tap the key — don't `--no-gpg-sign` without explicit permission.
- **CommonJS module format.** `tsconfig.json` has `"module": "CommonJS"`. Do not add `"type": "module"` to `package.json` without migrating `resend` to v4 and adding `.js` import extensions everywhere.
- **Strict TypeScript.** `noUncheckedIndexedAccess` is on. Tests pass `ctx as any` to handlers but production code should not.

## Error model (important)

Two error classes in `src/lib/errors.ts`:

- `TransientError` — `withRetry(fn, { delaysMs })` retries these (5xx, network blips, Telegram 429).
- `FatalError` — `withRetry` rethrows immediately (4xx, file-too-large, empty transcript, invalid email).

Service wrappers map provider errors to one of these. The forward handler wraps every external call with `withRetry`. If a call surfaces a non-typed error, it propagates and the top-level `try/catch` in `forward.ts` reacts with 💩 + an audit log row.

**Subject generation is the exception:** `subject.generateSubject` returns `string | null` (never throws), and a null is treated as "use fallback subject." This is per spec — subject generation must not delay or fail an otherwise valid email.

## Known type-safety compromises

- **`src/services/resend.ts:18`**: `(resend.emails.send as any)(...)`. The Resend v3 SDK overloads were noisy and the wrapper is fully verified by behavior tests. **Do not silently "fix"** this without checking that the actual Resend payload shape is preserved.
- **`tests/**` uses `ctx as any`** to satisfy minimal-ctx interfaces. Production code does not need this — grammy's `Context` is structurally assignable to `MinimalCtx` (onboarding), `AdminCallbackCtx` (admin), and `ReactCtx` (reactions, after we narrowed it to the 4 emojis we use).

## Running

```bash
npm install
npm test           # 85 unit tests, all mocked at SDK boundaries
npm run typecheck
npm run build      # tsc + cp schema.sql to dist/db/
npm run dev        # tsx watch
```

Real provider tests are **not in CI**. The first deploy is the first integration test — the spec acknowledged this.

## Docker

`Dockerfile` is two-stage, non-root (`USER node`, UID 1000). The bind-mounted host `./data` directory needs UID 1000 ownership — see README quick start.

## Auth state machine

```
(no row)         ─ /start ──────────► PENDING_EMAIL
PENDING_EMAIL    ─ /register email ─► PENDING_APPROVAL
PENDING_APPROVAL ─ admin approves ──► APPROVED        (terminal)
PENDING_APPROVAL ─ admin rejects ───► REJECTED        (terminal)
```

`APPROVED` is terminal in v1 — there is no admin UI to un-approve a user. Direct SQLite edit if needed.

## Things deliberately not implemented (v1)

- Files larger than 20 MB
- Edited-message re-send
- Email threading
- Inbound email replies
- Web admin UI
- Per-user provider/model preferences
- I18n
- Persistent media-group buffer (in-memory only; a crash mid-buffer loses those messages)

If a task touches one of these, check the spec — it might explicitly be out of scope.
