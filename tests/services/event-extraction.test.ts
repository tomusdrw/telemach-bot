// tests/services/event-extraction.test.ts
import { describe, expect, it, vi } from 'vitest';
import { makeEventExtractionClient } from '../../src/services/event-extraction';

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function chatResponseWith(content: string) {
  return { choices: [{ message: { content } }] };
}

const baseInput = {
  body: 'Spotkanie w czwartek o 14:10',
  nowInTz: '2026-05-19 09:00',
  timezone: 'Europe/Warsaw',
};

describe('event-extraction service', () => {
  it('returns EventData on a valid JSON response', async () => {
    const event = {
      summary: 'Spotkanie',
      allDay: false,
      start: '2026-05-21T14:10',
      end: '2026-05-21T15:10',
      location: null,
      description: null,
    };
    const fetchImpl = mockFetch(chatResponseWith(JSON.stringify({ event })));
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    const r = await client.extract(baseInput);
    expect(r).toEqual(event);
  });

  it('returns null when model returns {"event": null}', async () => {
    const fetchImpl = mockFetch(chatResponseWith(JSON.stringify({ event: null })));
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await client.extract(baseInput)).toBeNull();
  });

  it('returns null when model returns malformed JSON', async () => {
    const fetchImpl = mockFetch(chatResponseWith('not json'));
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await client.extract(baseInput)).toBeNull();
  });

  it('returns null when model returns JSON of wrong shape', async () => {
    const fetchImpl = mockFetch(chatResponseWith(JSON.stringify({ event: { summary: 'x' } })));
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await client.extract(baseInput)).toBeNull();
  });

  it('returns null on non-2xx', async () => {
    const fetchImpl = mockFetch({}, 500);
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await client.extract(baseInput)).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await client.extract(baseInput)).toBeNull();
  });

  it('sets response_format json_object in request body', async () => {
    const fetchImpl = mockFetch(chatResponseWith(JSON.stringify({ event: null })));
    const client = makeEventExtractionClient({ apiKey: 'k', model: 'm', fetchImpl });
    await client.extract(baseInput);
    const [, opts] = fetchImpl.mock.calls[0];
    const bodyJson = JSON.parse(opts.body);
    expect(bodyJson.response_format).toEqual({ type: 'json_object' });
    expect(bodyJson.model).toBe('m');
  });
});
