// tests/bot/forward.test.ts
import { describe, expect, it, vi } from 'vitest';
import { makeForwardHandler } from '../../src/bot/forward.js';
import { UserRepo } from '../../src/db/users.js';
import { FatalError } from '../../src/lib/errors.js';
import { buildFakeCtx } from '../helpers/fake-ctx.js';
import { makeTempDb } from '../helpers/temp-db.js';

function makeDeps(overrides: Partial<any> = {}) {
  const db = makeTempDb();
  const repo = new UserRepo(db);
  repo.upsertNew({ telegramId: 7, username: 'alice', firstName: 'Alice' });
  repo.setEmail(7, 'alice@x.com');
  repo.setStatus(7, 'APPROVED');
  const deps = {
    repo,
    fromEmail: 'bot@x.com',
    subject: { generateSubject: vi.fn().mockResolvedValue('Lunch plans') },
    expansion: { expand: vi.fn().mockResolvedValue(null) },
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
  return { deps, repo, db };
}

describe('forward handler', () => {
  // A long message (> 80 chars) keeps the AI-generated subject.
  const LONG_TEXT =
    'This is a deliberately long message that comfortably exceeds the eighty character subject threshold.';

  it('text message: 👀 → ✍ → 👍 with Resend called', async () => {
    const { deps } = makeDeps();
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: LONG_TEXT });
    await handler(ctx as any);
    expect(ctx.react.mock.calls.map((c) => c[0])).toEqual(['👀', '✍', '👍']);
    expect(deps.resend.send).toHaveBeenCalledTimes(1);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.to).toBe('alice@x.com');
    expect(payload.subject).toBe('Lunch plans');
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
    expect(deps.transcription.transcribe).toHaveBeenCalledTimes(1);
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
        buffer: Buffer.from([1]),
        filename: 'report.pdf',
        mimeType: null,
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

  it('uses live ctx.from for sender label even when DB row has null username/firstName', async () => {
    // Simulates the seedAdmin case: DB row exists with NULL username & first_name,
    // but the Telegram update carries fresh values.
    const repo = new UserRepo(makeTempDb());
    repo.seedAdmin({ telegramId: 7, email: 'alice@x.com' });
    const { deps } = makeDeps({ repo });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'hi there' }); // ctx.from has username:'alice', first_name:'Alice'
    await handler(ctx as any);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.text).toContain('Sent by @alice');
    expect(payload.text).not.toMatch(/user \d+/);
  });

  it('subject fallback when openrouter returns null (long message)', async () => {
    const { deps } = makeDeps({
      subject: { generateSubject: vi.fn().mockResolvedValue(null) },
    });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: LONG_TEXT });
    await handler(ctx as any);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.subject).toBe('Telegram message from @alice');
  });

  it('FatalError during transcription sets 💩, no email sent', async () => {
    const { deps } = makeDeps({
      transcription: {
        transcribe: vi.fn().mockRejectedValue(new FatalError('empty', { provider: 'openrouter' })),
      },
    });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({
      voice: { file_id: 'vf', file_unique_id: 'u', duration: 3 } as any,
    });
    await handler(ctx as any);
    expect(ctx.react.mock.calls.map((c) => c[0])).toEqual(['👀', '✍', '💩']);
    expect(deps.resend.send).not.toHaveBeenCalled();
  });

  it('Resend failure after Whisper success sets 💩 (no further work)', async () => {
    const { deps } = makeDeps({
      resend: {
        send: vi.fn().mockRejectedValue(new FatalError('domain not verified', { provider: 'resend' })),
      },
    });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({
      voice: { file_id: 'vf', file_unique_id: 'u', duration: 3 } as any,
    });
    await handler(ctx as any);
    expect(deps.transcription.transcribe).toHaveBeenCalled();
    expect(deps.resend.send).toHaveBeenCalledTimes(1);
    expect(ctx.react.mock.calls.map((c) => c[0])).toEqual(['👀', '✍', '💩']);
  });

  it('media group writes one `emailed` audit row per item with group details', async () => {
    const { deps } = makeDeps();
    const handler = makeForwardHandler(deps as any);
    const ctxs = [
      buildFakeCtx({
        message_id: 5001,
        media_group_id: 'audit-grp',
        photo: [{ file_id: 'p1', file_unique_id: '1', width: 800, height: 800 }] as any,
      }),
      buildFakeCtx({
        message_id: 5002,
        media_group_id: 'audit-grp',
        photo: [{ file_id: 'p2', file_unique_id: '2', width: 800, height: 800 }] as any,
      }),
    ];
    for (const c of ctxs) await handler(c as any);
    await vi.waitFor(() => expect(deps.resend.send).toHaveBeenCalled());

    const rows = (deps.repo as any).db
      .prepare(
        `SELECT chat_message_id, event, details FROM audit_log WHERE event = 'emailed' ORDER BY chat_message_id`,
      )
      .all();
    expect(rows.map((r: any) => r.chat_message_id)).toEqual([5001, 5002]);
    for (const r of rows) {
      const detail = JSON.parse(r.details);
      expect(detail.group).toBe(2);
      expect(detail.attachments).toBe(2);
    }
  });

  it('media group flush failure writes one `error` audit row per item', async () => {
    const { deps } = makeDeps({
      resend: { send: vi.fn().mockRejectedValue(new FatalError('boom', { provider: 'resend' })) },
    });
    const handler = makeForwardHandler(deps as any);
    const ctxs = [
      buildFakeCtx({
        message_id: 6001,
        media_group_id: 'err-grp',
        photo: [{ file_id: 'p1', file_unique_id: '1', width: 800, height: 800 }] as any,
      }),
      buildFakeCtx({
        message_id: 6002,
        media_group_id: 'err-grp',
        photo: [{ file_id: 'p2', file_unique_id: '2', width: 800, height: 800 }] as any,
      }),
    ];
    for (const c of ctxs) await handler(c as any);
    await vi.waitFor(() => {
      for (const c of ctxs) {
        expect(c.react.mock.calls.some((call) => call[0] === '💩')).toBe(true);
      }
    });

    const errs = (deps.repo as any).db
      .prepare(
        `SELECT chat_message_id, details FROM audit_log WHERE event = 'error' ORDER BY chat_message_id`,
      )
      .all();
    expect(errs.map((r: any) => r.chat_message_id)).toEqual([6001, 6002]);
    for (const r of errs) {
      const d = JSON.parse(r.details);
      expect(d.class).toBe('FatalError');
      expect(d.groupId).toBe('err-grp');
    }
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
    expect(deps.resend.send).toHaveBeenCalledTimes(1);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.attachments).toHaveLength(2);
  });

  it('media group flush failure marks every item with 💩', async () => {
    const { deps } = makeDeps({
      resend: { send: vi.fn().mockRejectedValue(new FatalError('boom', { provider: 'resend' })) },
    });
    const handler = makeForwardHandler(deps as any);
    const ctxs = [
      buildFakeCtx({
        media_group_id: 'g2',
        photo: [{ file_id: 'p1', file_unique_id: '1', width: 800, height: 800 }] as any,
      }),
      buildFakeCtx({
        media_group_id: 'g2',
        photo: [{ file_id: 'p2', file_unique_id: '2', width: 800, height: 800 }] as any,
      }),
    ];
    for (const c of ctxs) await handler(c as any);

    await vi.waitFor(() => {
      for (const c of ctxs) {
        expect(c.react.mock.calls.some((call) => call[0] === '💩')).toBe(true);
      }
    });
    // Each item should have seen 👀 (received) then ✍ (working) then 💩 (failed)
    for (const c of ctxs) {
      const emojis = c.react.mock.calls.map((call) => call[0]);
      expect(emojis).toEqual(['👀', '✍', '💩']);
    }
  });

  // -------- persistence + replay ------------------------------------------

  it('media group: each item is persisted to media_group_pending on receipt', async () => {
    const { deps, repo } = makeDeps();
    const handler = makeForwardHandler(deps as any);
    const ctxs = [
      buildFakeCtx({
        media_group_id: 'gp1',
        photo: [{ file_id: 'p1', file_unique_id: '1', width: 800, height: 800 }] as any,
      }),
      buildFakeCtx({
        media_group_id: 'gp1',
        photo: [{ file_id: 'p2', file_unique_id: '2', width: 800, height: 800 }] as any,
      }),
    ];
    for (const c of ctxs) await handler(c as any);

    // Right after add (before flush), both rows should be in the table.
    const pending = repo.listAllPendingMediaGroups();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.groupId).toBe('gp1');
    expect(pending[0]!.items).toHaveLength(2);
    expect(pending[0]!.items[0]!.messageId).toBe(ctxs[0]!.message.message_id);
  });

  it('media group flush deletes the persisted rows after sending', async () => {
    const { deps, repo } = makeDeps();
    const handler = makeForwardHandler(deps as any);
    const ctxs = [
      buildFakeCtx({
        media_group_id: 'gp2',
        photo: [{ file_id: 'p1', file_unique_id: '1', width: 800, height: 800 }] as any,
      }),
      buildFakeCtx({
        media_group_id: 'gp2',
        photo: [{ file_id: 'p2', file_unique_id: '2', width: 800, height: 800 }] as any,
      }),
    ];
    for (const c of ctxs) await handler(c as any);

    await vi.waitFor(() => expect(deps.resend.send).toHaveBeenCalled());
    expect(repo.listAllPendingMediaGroups()).toHaveLength(0);
  });

  it('replayPending: groups in DB at startup are processed with api-based reactions', async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(true);
    const { deps, repo } = makeDeps({ api: { setMessageReaction } });
    // Seed two persisted items from a previous run
    const payload = JSON.stringify({
      kind: { fileId: 'p1', filenameHint: 'photo.jpg', isVoice: false, text: 'cap' },
      user: { email: 'alice@x.com', username: 'alice', firstName: 'Alice', telegramId: 7 },
    });
    repo.addMediaGroupItem({
      groupId: 'oldgrp',
      telegramId: 7,
      chatId: 7,
      messageId: 100,
      payloadJson: payload,
    });
    repo.addMediaGroupItem({
      groupId: 'oldgrp',
      telegramId: 7,
      chatId: 7,
      messageId: 101,
      payloadJson: payload,
    });

    const handler = makeForwardHandler(deps as any);
    await handler.replayPending();

    // Email sent once, both rows deleted, api.setMessageReaction called for both items
    expect(deps.resend.send).toHaveBeenCalledTimes(1);
    expect(repo.listAllPendingMediaGroups()).toHaveLength(0);
    // Each item: ✍ (working) + 👍 (done). Total of 4 reaction calls.
    const calls = setMessageReaction.mock.calls;
    expect(calls.length).toBe(4);
    expect(calls.map((c) => c[2]?.[0]?.emoji)).toEqual(['✍', '✍', '👍', '👍']);
  });

  it('replayPending: drops a row with corrupt payload_json and processes the rest', async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(true);
    const { deps, repo } = makeDeps({ api: { setMessageReaction } });
    const goodPayload = JSON.stringify({
      kind: { fileId: 'p1', filenameHint: 'photo.jpg', isVoice: false, text: '' },
      user: { email: 'alice@x.com', username: 'alice', firstName: 'Alice', telegramId: 7 },
    });
    repo.addMediaGroupItem({
      groupId: 'mix',
      telegramId: 7,
      chatId: 7,
      messageId: 200,
      payloadJson: '{not json',
    });
    repo.addMediaGroupItem({
      groupId: 'mix',
      telegramId: 7,
      chatId: 7,
      messageId: 201,
      payloadJson: goodPayload,
    });

    const handler = makeForwardHandler(deps as any);
    await handler.replayPending();

    expect(deps.resend.send).toHaveBeenCalledTimes(1);
    expect(repo.listAllPendingMediaGroups()).toHaveLength(0);
  });

  it('replayPending: no-op when nothing is pending', async () => {
    const { deps } = makeDeps();
    const handler = makeForwardHandler(deps as any);
    await handler.replayPending();
    expect(deps.resend.send).not.toHaveBeenCalled();
  });

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
    const { deps, db } = makeDeps({ events });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'Spotkanie w czwartek o 14:10' });
    await handler(ctx as any);

    const payload = deps.resend.send.mock.calls[0][0];
    const ics = payload.attachments.find((a: any) => a.filename === 'event.ics');
    expect(ics).toBeTruthy();
    expect(ics.contentType).toBe('text/calendar; method=PUBLISH; charset=UTF-8');
    expect(payload.text).toContain('📅 Event attached:');
    expect(payload.text).toContain('Spotkanie');

    const audit = db.prepare(`SELECT event FROM audit_log WHERE telegram_id = ? ORDER BY id`).all(7) as {
      event: string;
    }[];
    const types = audit.map((r) => r.event);
    expect(types).toContain('event_extracted');
    expect(types).toContain('event_attached');

    const reactionsCalled = ctx.react.mock.calls.map((c) => c[0]);
    expect(reactionsCalled).toContain('📅');
    expect(reactionsCalled).toContain('👍');
  });

  it('no .ics, no body note, no event audit when extraction returns null', async () => {
    const events = { extract: vi.fn().mockResolvedValue(null) };
    const { deps, db } = makeDeps({ events });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'random no-date message' });
    await handler(ctx as any);

    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.attachments).toEqual([]);
    expect(payload.text).not.toContain('📅');

    const types = (
      db.prepare(`SELECT event FROM audit_log WHERE telegram_id = ?`).all(7) as { event: string }[]
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

    expect(events.extract).toHaveBeenCalledWith(expect.objectContaining({ body: 'Turnus 14.05 - 16.05' }));
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.attachments.some((a: any) => a.filename === 'event.ics')).toBe(true);
  });

  it('formatEventNote: year-crossing all-day range shows both years', async () => {
    const event = {
      summary: 'New Year Span',
      allDay: true,
      start: '2026-12-30',
      end: '2027-01-02',
      location: null,
      description: null,
    };
    const events = { extract: vi.fn().mockResolvedValue(event) };
    const { deps } = makeDeps({ events });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'some message with dates' });
    await handler(ctx as any);

    const payload = deps.resend.send.mock.calls[0][0];
    const note: string = payload.text;
    expect(note).toContain('2026');
    expect(note).toContain('2027');
    expect(note).toContain('30 December');
    expect(note).toContain('2 January');
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
      photo: [{ file_id: 'p1', file_unique_id: '1', width: 10, height: 10, file_size: 10 }] as any,
    });
    await handler(ctx as any);
    // change timezone after enqueue
    repo.updateTimezone(7, 'America/New_York');
    await new Promise((r) => setTimeout(r, 20));

    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'Europe/Warsaw' }));
  });

  // -------- verbatim subject + body expansion ----------------------------

  it('short text message: subject is the message verbatim and AI subject is not called', async () => {
    const { deps } = makeDeps();
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'kup mleko' });
    await handler(ctx as any);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.subject).toBe('kup mleko');
    expect(deps.subject.generateSubject).not.toHaveBeenCalled();
  });

  it('long text message: subject uses the AI path', async () => {
    const { deps } = makeDeps();
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: LONG_TEXT });
    await handler(ctx as any);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.subject).toBe('Lunch plans');
    expect(deps.subject.generateSubject).toHaveBeenCalledTimes(1);
  });

  it('appends the AI-cleaned rendition below the original with a separator', async () => {
    const { deps } = makeDeps({
      expansion: { expand: vi.fn().mockResolvedValue('To jest notatka, rozwinięta.') },
    });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'notatka' });
    await handler(ctx as any);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(deps.expansion.expand).toHaveBeenCalledWith('notatka');
    expect(payload.text).toContain('notatka');
    expect(payload.text).toContain('———');
    expect(payload.text).toContain('✍️ To jest notatka, rozwinięta.');
    // original stays above the rendition
    expect(payload.text.indexOf('notatka')).toBeLessThan(payload.text.indexOf('✍️'));
  });

  it('does not append a rendition that only differs by case/punctuation', async () => {
    const { deps } = makeDeps({
      expansion: { expand: vi.fn().mockResolvedValue('Kup mleko.') },
    });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'kup mleko' });
    await handler(ctx as any);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(deps.expansion.expand).toHaveBeenCalled();
    expect(payload.text).not.toContain('✍️');
    expect(payload.text).not.toContain('———');
  });

  it('null expansion → body is the original only', async () => {
    const { deps } = makeDeps(); // default expansion resolves null
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'notatka' });
    await handler(ctx as any);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.text).not.toContain('✍️');
    expect(payload.text).toContain('notatka');
  });

  it('expansion failure does not fail or delay the email', async () => {
    const { deps } = makeDeps({
      expansion: { expand: vi.fn().mockRejectedValue(new Error('boom')) },
    });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'notatka' });
    await handler(ctx as any);
    expect(deps.resend.send).toHaveBeenCalledTimes(1);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.text).not.toContain('✍️');
    expect(ctx.react.mock.calls.map((c) => c[0])).toEqual(['👀', '✍', '👍']);
  });

  it('short voice transcript: verbatim subject + expansion appended', async () => {
    const { deps } = makeDeps({
      expansion: { expand: vi.fn().mockResolvedValue('Kup mleko dzisiaj wieczorem.') },
    });
    deps.transcription.transcribe.mockResolvedValue('kup mleko');
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({
      voice: { file_id: 'vf', file_unique_id: 'u', duration: 3 } as any,
    });
    await handler(ctx as any);
    const payload = deps.resend.send.mock.calls[0][0];
    expect(payload.subject).toBe('kup mleko');
    expect(deps.subject.generateSubject).not.toHaveBeenCalled();
    expect(payload.text).toContain('✍️ Kup mleko dzisiaj wieczorem.');
  });

  it('drain() flushes buffered media groups immediately', async () => {
    // Long debounce window so the timer doesn't fire on its own.
    const { deps, repo } = makeDeps({ mediaGroupFlushMs: 60_000 });
    const handler = makeForwardHandler(deps as any);
    const ctxs = [
      buildFakeCtx({
        media_group_id: 'drain-grp',
        photo: [{ file_id: 'p1', file_unique_id: '1', width: 800, height: 800 }] as any,
      }),
      buildFakeCtx({
        media_group_id: 'drain-grp',
        photo: [{ file_id: 'p2', file_unique_id: '2', width: 800, height: 800 }] as any,
      }),
    ];
    for (const c of ctxs) await handler(c as any);
    // Buffer hasn't flushed yet — timer is way in the future.
    expect(deps.resend.send).not.toHaveBeenCalled();
    expect(repo.listAllPendingMediaGroups()).toHaveLength(1);

    await handler.drain();

    expect(deps.resend.send).toHaveBeenCalledTimes(1);
    expect(repo.listAllPendingMediaGroups()).toHaveLength(0);
    for (const c of ctxs) {
      const emojis = c.react.mock.calls.map((call) => call[0]);
      expect(emojis).toEqual(['👀', '✍', '👍']);
    }
  });
});
