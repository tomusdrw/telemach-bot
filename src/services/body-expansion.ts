import { z } from 'zod';
import { buildExpansionPrompt } from '../bot/body-expansion-prompt.js';
import { logger } from '../lib/logger.js';

export interface BodyExpansionClient {
  expand(body: string): Promise<string | null>;
}

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string(),
        }),
      }),
    )
    .min(1),
});

export interface BodyExpansionClientOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export function makeBodyExpansionClient(opts: BodyExpansionClientOptions): BodyExpansionClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async expand(body) {
      try {
        const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: opts.model,
            messages: [{ role: 'user', content: buildExpansionPrompt(body) }],
            max_tokens: 500,
            temperature: 0.3,
          }),
        });
        if (!res.ok) {
          logger.warn({ status: res.status }, 'body-expansion: non-2xx');
          return null;
        }
        const json = await res.json();
        const parsed = responseSchema.safeParse(json);
        if (!parsed.success) {
          logger.warn({ json }, 'body-expansion: response shape unexpected');
          return null;
        }
        return parsed.data.choices[0]!.message.content;
      } catch (err) {
        logger.warn({ err }, 'body-expansion: call threw');
        return null;
      }
    },
  };
}
