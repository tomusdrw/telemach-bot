import { describe, expect, it, vi } from 'vitest';
import { FatalError, TransientError } from '../../src/lib/errors.js';
import { makeTranscriptionClient } from '../../src/services/transcription.js';

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

describe('transcription service', () => {
  it('returns the transcript text on success', async () => {
    const fetchImpl = mockFetch(200, { text: 'hello world', usage: { cost: 0.001 } });
    const c = makeTranscriptionClient({
      apiKey: 'k',
      model: 'openai/whisper-large-v3',
      fetchImpl,
    });
    const text = await c.transcribe({ audio: Buffer.from('abc'), filename: 'voice.ogg' });
    expect(text).toBe('hello world');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer k',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('sends the audio as base64 with format derived from filename', async () => {
    const fetchImpl = mockFetch(200, { text: 'ok' });
    const c = makeTranscriptionClient({ apiKey: 'k', model: 'm', fetchImpl });
    await c.transcribe({ audio: Buffer.from([1, 2, 3, 4]), filename: 'voice.oga' });
    const sentBody = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(sentBody.model).toBe('m');
    expect(sentBody.input_audio.data).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
    expect(sentBody.input_audio.format).toBe('ogg'); // .oga → ogg
  });

  it('maps .mp4 voice notes to m4a format', async () => {
    const fetchImpl = mockFetch(200, { text: 'ok' });
    const c = makeTranscriptionClient({ apiKey: 'k', model: 'm', fetchImpl });
    await c.transcribe({ audio: Buffer.from('x'), filename: 'voicenote.mp4' });
    const sentBody = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(sentBody.input_audio.format).toBe('m4a');
  });

  it('throws FatalError on empty transcript', async () => {
    const fetchImpl = mockFetch(200, { text: '   ' });
    const c = makeTranscriptionClient({ apiKey: 'k', model: 'm', fetchImpl });
    await expect(c.transcribe({ audio: Buffer.from('a'), filename: 'voice.ogg' })).rejects.toBeInstanceOf(
      FatalError,
    );
  });

  it('maps 5xx to TransientError', async () => {
    const fetchImpl = mockFetch(503, { error: 'boom' });
    const c = makeTranscriptionClient({ apiKey: 'k', model: 'm', fetchImpl });
    await expect(c.transcribe({ audio: Buffer.from('a'), filename: 'voice.ogg' })).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it('maps 429 to TransientError', async () => {
    const fetchImpl = mockFetch(429, { error: 'rate' });
    const c = makeTranscriptionClient({ apiKey: 'k', model: 'm', fetchImpl });
    await expect(c.transcribe({ audio: Buffer.from('a'), filename: 'voice.ogg' })).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it('maps 4xx (non-429) to FatalError', async () => {
    const fetchImpl = mockFetch(400, { error: 'bad audio' });
    const c = makeTranscriptionClient({ apiKey: 'k', model: 'm', fetchImpl });
    await expect(c.transcribe({ audio: Buffer.from('a'), filename: 'voice.ogg' })).rejects.toBeInstanceOf(
      FatalError,
    );
  });

  it('maps fetch rejection to TransientError', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENETUNREACH'));
    const c = makeTranscriptionClient({ apiKey: 'k', model: 'm', fetchImpl });
    await expect(c.transcribe({ audio: Buffer.from('a'), filename: 'voice.ogg' })).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it('maps unexpected response shape to FatalError', async () => {
    const fetchImpl = mockFetch(200, { not_what_we_expect: true });
    const c = makeTranscriptionClient({ apiKey: 'k', model: 'm', fetchImpl });
    await expect(c.transcribe({ audio: Buffer.from('a'), filename: 'voice.ogg' })).rejects.toBeInstanceOf(
      FatalError,
    );
  });
});
