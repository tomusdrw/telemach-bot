// tests/helpers/fake-ctx.ts

import type { Message } from 'grammy/types';
import { vi } from 'vitest';

export interface FakeCtx {
  from: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: 'private' };
  message: Partial<Message> & { message_id: number; date: number };
  react: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
}

export function buildFakeCtx(overrides: Partial<FakeCtx['message']> = {}): FakeCtx {
  return {
    from: { id: 7, username: 'alice', first_name: 'Alice' },
    chat: { id: 7, type: 'private' },
    message: {
      message_id: 1001,
      date: Math.floor(new Date('2026-01-02T03:04:05Z').getTime() / 1000),
      ...overrides,
    },
    react: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}
