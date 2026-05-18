import { describe, it, expect, vi } from 'vitest';
import { TransientError, FatalError, withRetry } from '../../src/lib/errors';

describe('errors', () => {
  it('TransientError and FatalError are distinct named classes', () => {
    const t = new TransientError('boom', { provider: 'whisper' });
    const f = new FatalError('nope', { provider: 'resend' });
    expect(t).toBeInstanceOf(TransientError);
    expect(t.name).toBe('TransientError');
    expect(t.provider).toBe('whisper');
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
    const fn = vi.fn()
      .mockRejectedValueOnce(new TransientError('1', { provider: 'whisper' }))
      .mockRejectedValueOnce(new TransientError('2', { provider: 'whisper' }))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { delaysMs: [1, 1, 1] });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('withRetry does NOT retry FatalError', async () => {
    const fn = vi.fn().mockRejectedValue(new FatalError('bad', { provider: 'whisper' }));
    await expect(withRetry(fn, { delaysMs: [1, 1, 1] })).rejects.toBeInstanceOf(FatalError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('withRetry exhausts retries and rethrows', async () => {
    const err = new TransientError('still bad', { provider: 'whisper' });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { delaysMs: [1, 1] })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
