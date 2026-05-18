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
    expect(deps.resend.send).toHaveBeenCalledTimes(1);
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
    expect(deps.whisper.transcribe).toHaveBeenCalledTimes(1);
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

  it('Resend failure after Whisper success sets 💩 (no further work)', async () => {
    const { deps } = makeDeps({
      resend: { send: vi.fn().mockRejectedValue(new FatalError('domain not verified', { provider: 'resend' })) },
    });
    const handler = makeForwardHandler(deps as any);
    const ctx = buildFakeCtx({
      voice: { file_id: 'vf', file_unique_id: 'u', duration: 3 } as any,
    });
    await handler(ctx as any);
    expect(deps.whisper.transcribe).toHaveBeenCalled();
    expect(deps.resend.send).toHaveBeenCalledTimes(1);
    expect(ctx.react.mock.calls.map((c) => c[0])).toEqual(['👀', '✍', '💩']);
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
});
