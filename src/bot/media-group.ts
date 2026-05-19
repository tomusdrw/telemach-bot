// src/bot/media-group.ts
export type FlushHandler<T> = (groupId: string, items: T[]) => void | Promise<void>;

interface Entry<T> {
  items: T[];
  timer: NodeJS.Timeout;
}

export class MediaGroupBuffer<T> {
  private readonly groups = new Map<string, Entry<T>>();

  constructor(
    private readonly debounceMs: number,
    private readonly onFlush: FlushHandler<T>,
  ) {}

  add(groupId: string, item: T): void {
    const existing = this.groups.get(groupId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(item);
      existing.timer = this.scheduleFlush(groupId);
      return;
    }
    this.groups.set(groupId, {
      items: [item],
      timer: this.scheduleFlush(groupId),
    });
  }

  private scheduleFlush(groupId: string): NodeJS.Timeout {
    return setTimeout(() => {
      const entry = this.groups.get(groupId);
      if (!entry) return;
      this.groups.delete(groupId);
      // intentionally fire-and-forget; caller logs errors inside onFlush
      void this.onFlush(groupId, entry.items);
    }, this.debounceMs);
  }

  /**
   * Cancel all pending timers and fire onFlush for each group synchronously.
   * Intended for graceful shutdown — drain in-flight groups so they don't
   * fire after the surrounding resources (DB) are closed.
   */
  async flush(): Promise<void> {
    const entries = Array.from(this.groups.entries());
    this.groups.clear();
    for (const [, entry] of entries) {
      clearTimeout(entry.timer);
    }
    await Promise.all(entries.map(([groupId, entry]) => this.onFlush(groupId, entry.items)));
  }
}
