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
}
