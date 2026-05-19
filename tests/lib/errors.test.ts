import { describe, expect, it, vi } from 'vitest';
import { FatalError, TransientError, withRetry } from '../../src/lib/errors.js';

describe('errors', () => {
  it('TransientError and FatalError are distinct named classes', () => {
    const t = new TransientError('boom', { provider: 'openrouter' });
    const f = new FatalError('nope', { provider: 'resend' });
    expect(t).toBeInstanceOf(TransientError);
    expect(t.name).toBe('TransientError');
    expect(t.provider).toBe('openrouter');
    expect(f).toBeInstanceOf(FatalError);
    expect(f.name).toBe('FatalError');
    expect(f.provider).toBe('resend');
  });

  it('withRetry returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn, { delaysMs: [10, 20, 40] });
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('withRetry retries TransientError up to delays.length+1 times', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TransientError('1', { provider: 'openrouter' }))
      .mockRejectedValueOnce(new TransientError('2', { provider: 'openrouter' }))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { delaysMs: [1, 1, 1] });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('withRetry does NOT retry FatalError', async () => {
    const fn = vi.fn().mockRejectedValue(new FatalError('bad', { provider: 'openrouter' }));
    await expect(withRetry(fn, { delaysMs: [1, 1, 1] })).rejects.toBeInstanceOf(FatalError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('withRetry exhausts retries and rethrows', async () => {
    const err = new TransientError('still bad', { provider: 'openrouter' });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { delaysMs: [1, 1] })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
