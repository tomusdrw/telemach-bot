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
        if (status && (status === 429 || status >= 500)) {
          throw new TransientError('whisper retryable', { provider: 'whisper', detail: err });
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
