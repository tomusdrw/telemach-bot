import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaGroupBuffer } from '../../src/bot/media-group.js';

describe('MediaGroupBuffer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flushes a single-element group after debounce window', async () => {
    const onFlush = vi.fn();
    const buf = new MediaGroupBuffer<{ id: number }>(50, onFlush);

    buf.add('g1', { id: 1 });
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    await Promise.resolve();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('g1', [{ id: 1 }]);
  });

  it('extends timer on each addition to the same group', async () => {
    const onFlush = vi.fn();
    const buf = new MediaGroupBuffer<{ id: number }>(50, onFlush);

    buf.add('g1', { id: 1 });
    vi.advanceTimersByTime(40);
    buf.add('g1', { id: 2 });
    vi.advanceTimersByTime(40);
    buf.add('g1', { id: 3 });
    vi.advanceTimersByTime(40);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    await Promise.resolve();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('g1', [{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('keeps groups independent', async () => {
    const onFlush = vi.fn();
    const buf = new MediaGroupBuffer<{ id: number }>(50, onFlush);

    buf.add('g1', { id: 1 });
    buf.add('g2', { id: 99 });
    vi.advanceTimersByTime(50);
    await Promise.resolve();
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenCalledWith('g1', [{ id: 1 }]);
    expect(onFlush).toHaveBeenCalledWith('g2', [{ id: 99 }]);
  });

  it('removes group from internal state after flush (re-adding starts fresh)', async () => {
    const onFlush = vi.fn();
    const buf = new MediaGroupBuffer<{ id: number }>(50, onFlush);

    buf.add('g1', { id: 1 });
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    buf.add('g1', { id: 2 });
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenNthCalledWith(2, 'g1', [{ id: 2 }]);
  });

  it('flush() drains every group synchronously and clears timers', async () => {
    const onFlush = vi.fn();
    const buf = new MediaGroupBuffer<{ id: number }>(50, onFlush);

    buf.add('g1', { id: 1 });
    buf.add('g1', { id: 2 });
    buf.add('g2', { id: 99 });

    await buf.flush();

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenCalledWith('g1', [{ id: 1 }, { id: 2 }]);
    expect(onFlush).toHaveBeenCalledWith('g2', [{ id: 99 }]);

    // Advancing timers past the debounce window after flush should NOT
    // re-fire onFlush (proves the timers were cleared).
    vi.advanceTimersByTime(200);
    await Promise.resolve();
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it('flush() on an empty buffer is a no-op', async () => {
    const onFlush = vi.fn();
    const buf = new MediaGroupBuffer<{ id: number }>(50, onFlush);
    await buf.flush();
    expect(onFlush).not.toHaveBeenCalled();
  });
});
