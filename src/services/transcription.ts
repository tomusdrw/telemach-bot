// src/services/transcription.ts
import { z } from 'zod';
import { FatalError, TransientError } from '../lib/errors';

export interface TranscriptionClient {
  transcribe(input: { audio: Buffer; filename: string }): Promise<string>;
}

const responseSchema = z.object({
  text: z.string(),
});

// Telegram voice files come back as .oga (Opus in OGG container). Most other
// attachments use their natural extension. OpenRouter's `format` field accepts
// the codec/container short name (wav, mp3, flac, m4a, ogg, webm, aac).
function extensionToFormat(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return 'ogg';
  if (ext === 'oga') return 'ogg';
  if (ext === 'mp4') return 'm4a';
  return ext;
}

export interface TranscriptionClientOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export function makeTranscriptionClient(opts: TranscriptionClientOptions): TranscriptionClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async transcribe({ audio, filename }) {
      const format = extensionToFormat(filename);
      const data = audio.toString('base64');

      let res: Awaited<ReturnType<typeof fetchImpl>>;
      try {
        res = await fetchImpl('https://openrouter.ai/api/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: opts.model,
            input_audio: { data, format },
          }),
        });
      } catch (err) {
        throw new TransientError('openrouter transcription fetch failed', {
          provider: 'openrouter',
          detail: err,
        });
      }

      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          throw new TransientError(`openrouter transcription ${res.status}`, {
            provider: 'openrouter',
          });
        }
        let bodyText = '';
        try {
          bodyText = await res.text();
        } catch {
          /* ignore */
        }
        throw new FatalError(`openrouter transcription ${res.status}: ${bodyText.slice(0, 200)}`, {
          provider: 'openrouter',
        });
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        throw new TransientError('openrouter transcription body parse failed', {
          provider: 'openrouter',
          detail: err,
        });
      }

      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) {
        throw new FatalError('openrouter transcription response shape unexpected', {
          provider: 'openrouter',
          detail: json,
        });
      }

      const text = parsed.data.text.trim();
      if (text.length === 0) {
        throw new FatalError('empty transcript', { provider: 'openrouter' });
      }
      return text;
    },
  };
}
