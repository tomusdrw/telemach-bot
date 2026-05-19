// src/services/event-extraction.ts
import { z } from 'zod';
import { buildEventPrompt, type EventData, parseEventResponse } from '../bot/event-prompt';
import { logger } from '../lib/logger';

export interface EventExtractionClient {
  extract(input: { body: string; nowInTz: string; timezone: string }): Promise<EventData | null>;
}

export interface EventExtractionOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

const chatSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

export function makeEventExtractionClient(opts: EventExtractionOptions): EventExtractionClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async extract(input) {
      try {
        const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: opts.model,
            messages: [{ role: 'user', content: buildEventPrompt(input) }],
            response_format: { type: 'json_object' },
            temperature: 0.1,
            max_tokens: 400,
          }),
        });
        if (!res.ok) {
          logger.warn({ status: res.status }, 'event-extraction: non-2xx');
          return null;
        }
        const json = await res.json();
        const parsed = chatSchema.safeParse(json);
        if (!parsed.success) {
          logger.warn({ json }, 'event-extraction: response shape unexpected');
          return null;
        }
        const content = parsed.data.choices[0]!.message.content;
        let obj: unknown;
        try {
          obj = JSON.parse(content);
        } catch {
          logger.warn({ content }, 'event-extraction: content not JSON');
          return null;
        }
        return parseEventResponse(obj);
      } catch (err) {
        logger.warn({ err }, 'event-extraction: call threw');
        return null;
      }
    },
  };
}
