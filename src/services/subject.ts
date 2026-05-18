import { z } from 'zod';
import { logger } from '../lib/logger';
import { buildSubjectPrompt } from '../bot/subject-prompt';

export interface SubjectClient {
  generateSubject(body: string): Promise<string | null>;
}

const responseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string(),
      }),
    })
  ).min(1),
});

export interface SubjectClientOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export function makeSubjectClient(opts: SubjectClientOptions): SubjectClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async generateSubject(body) {
      try {
        const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: opts.model,
            messages: [
              { role: 'user', content: buildSubjectPrompt(body) },
            ],
            max_tokens: 60,
            temperature: 0.3,
          }),
        });
        if (!res.ok) {
          logger.warn({ status: res.status }, 'openrouter non-2xx');
          return null;
        }
        const json = await res.json();
        const parsed = responseSchema.safeParse(json);
        if (!parsed.success) {
          logger.warn({ json }, 'openrouter response shape unexpected');
          return null;
        }
        return parsed.data.choices[0]!.message.content;
      } catch (err) {
        logger.warn({ err }, 'openrouter call threw');
        return null;
      }
    },
  };
}
