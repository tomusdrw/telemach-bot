// tests/bot/forward.test.ts
import { describe, expect, it, vi } from 'vitest';
import { makeForwardHandler } from '../../src/bot/forward';
import { UserRepo } from '../../src/db/users';
import { FatalError } from '../../src/lib/errors';
import { buildFakeCtx } from '../helpers/fake-ctx';
import { makeTempDb } from '../helpers/temp-db';

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

  it('subject fallback when openrouter returns null', async () => {
    const { deps } = makeDeps({
      subject: { generateSubject: vi.fn().mockResolvedValue(null) },
    });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({ text: 'hi' });
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
});
