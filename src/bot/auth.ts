// src/bot/auth.ts
import type { UserStatus } from '../db/users.js';

export interface UserView {
  telegramId: number;
  status: UserStatus;
  isAdmin: boolean;
}

export type Input = { kind: 'start' } | { kind: 'register'; email: string } | { kind: 'message' };

export type Action =
  | { type: 'create-and-greet' }
  | { type: 'create-and-register'; email: string }
  | { type: 'register'; email: string }
  | { type: 'nag-register' }
  | { type: 'forward' }
  | { type: 'already-set-up' }
  | { type: 'cannot-change-email' }
  | { type: 'ignore' };

export function decideAction(user: UserView | null, input: Input): Action {
  if (user === null) {
    if (input.kind === 'start') return { type: 'create-and-greet' };
    if (input.kind === 'register') return { type: 'create-and-register', email: input.email };
    return { type: 'ignore' };
  }
  if (user.status === 'REJECTED') return { type: 'ignore' };
  if (user.status === 'PENDING_EMAIL') {
    if (input.kind === 'register') return { type: 'register', email: input.email };
    if (input.kind === 'message') return { type: 'nag-register' };
    return { type: 'ignore' }; // /start on existing PENDING_EMAIL: no-op
  }
  if (user.status === 'PENDING_APPROVAL') {
    if (input.kind === 'register') return { type: 'register', email: input.email };
    return { type: 'ignore' };
  }
  // APPROVED
  if (input.kind === 'message') return { type: 'forward' };
  if (input.kind === 'start') return { type: 'already-set-up' };
  return { type: 'cannot-change-email' };
}
