import { describe, expect, it, vi } from 'vitest';
import { makeBodyExpansionClient } from '../../src/services/body-expansion.js';

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('body-expansion service', () => {
  it('returns the model response on success', async () => {
    const fetchImpl = mockFetch({
      choices: [{ message: { content: 'Kup mleko.' } }],
    });
    const c = makeBodyExpansionClient({ apiKey: 'k', model: 'm', fetchImpl });
    const out = await c.expand('kup mleko');
    // sanitization happens in the bot layer; the service returns the raw content
    expect(out).toBe('Kup mleko.');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer k' }),
      }),
    );
    const [, opts] = fetchImpl.mock.calls[0];
    expect(JSON.parse(opts.body).model).toBe('m');
  });

  it('returns null when API returns non-2xx', async () => {
    const fetchImpl = mockFetch({}, 500);
    const c = makeBodyExpansionClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await c.expand('x')).toBeNull();
  });

  it('returns null when response shape is missing content', async () => {
    const fetchImpl = mockFetch({ choices: [] });
    const c = makeBodyExpansionClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await c.expand('x')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));
    const c = makeBodyExpansionClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await c.expand('x')).toBeNull();
  });
});
