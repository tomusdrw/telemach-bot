import { describe, expect, it, vi } from 'vitest';
import { markDone, markFailed, markReceived, markWorking } from '../../src/bot/reactions.js';

function fakeCtx() {
  const react = vi.fn().mockResolvedValue(undefined);
  return { react, _react: react };
}

describe('reactions', () => {
  it('markReceived sets 👀', async () => {
    const ctx = fakeCtx();
    await markReceived(ctx as any);
    expect(ctx._react).toHaveBeenCalledWith('👀');
  });

  it('markWorking sets ✍', async () => {
    const ctx = fakeCtx();
    await markWorking(ctx as any);
    expect(ctx._react).toHaveBeenCalledWith('✍');
  });

  it('markDone sets 👍', async () => {
    const ctx = fakeCtx();
    await markDone(ctx as any);
    expect(ctx._react).toHaveBeenCalledWith('👍');
  });

  it('markFailed sets 💩', async () => {
    const ctx = fakeCtx();
    await markFailed(ctx as any);
    expect(ctx._react).toHaveBeenCalledWith('💩');
  });

  it('swallows errors from react() and does not throw', async () => {
    const ctx = { react: vi.fn().mockRejectedValue(new Error('msg deleted')) };
    await expect(markDone(ctx as any)).resolves.toBeUndefined();
  });

  it('markEventAttached sets 📅', async () => {
    const ctx = fakeCtx();
    const { markEventAttached } = await import('../../src/bot/reactions');
    await markEventAttached(ctx as any);
    expect(ctx._react).toHaveBeenCalledWith('📅');
  });
});
