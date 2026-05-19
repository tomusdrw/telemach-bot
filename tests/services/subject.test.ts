import { describe, expect, it, vi } from 'vitest';
import { makeSubjectClient } from '../../src/services/subject.js';

function mockFetch(body: any, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('subject service', () => {
  it('returns the model response on success', async () => {
    const fetchImpl = mockFetch({
      choices: [{ message: { content: '"Lunch plans"' } }],
    });
    const c = makeSubjectClient({
      apiKey: 'k',
      model: 'google/gemini-flash-1.5',
      fetchImpl,
    });
    const subject = await c.generateSubject('let us meet at noon');
    // sanitization happens in the bot layer; here we just return the raw
    expect(subject).toBe('"Lunch plans"');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer k',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('returns null when API returns non-2xx (callers use fallback)', async () => {
    const fetchImpl = mockFetch({}, 500);
    const c = makeSubjectClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await c.generateSubject('x')).toBeNull();
  });

  it('returns null when response shape is missing content', async () => {
    const fetchImpl = mockFetch({ choices: [] });
    const c = makeSubjectClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await c.generateSubject('x')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));
    const c = makeSubjectClient({ apiKey: 'k', model: 'm', fetchImpl });
    expect(await c.generateSubject('x')).toBeNull();
  });
});
