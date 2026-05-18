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

  it('maps 429 rate-limit errors to TransientError', async () => {
    const err: any = new Error('rate limited');
    err.status = 429;
    const fake = makeFakeOpenAI(async () => { throw err; });
    const w = makeWhisperClient(fake as any);
    await expect(
      w.transcribe({ audio: Buffer.from('abc'), filename: 'voice.ogg' })
    ).rejects.toBeInstanceOf(TransientError);
  });
});
