// tests/bot/auth.test.ts
import { describe, expect, it } from 'vitest';
import { decideAction, type UserView } from '../../src/bot/auth.js';
import type { UserStatus } from '../../src/db/users.js';

const mkUser = (status: UserStatus | null): UserView | null =>
  status === null ? null : { telegramId: 1, status, isAdmin: false };

describe('decideAction', () => {
  it('unknown user + /start → create+greet', () => {
    expect(decideAction(mkUser(null), { kind: 'start' })).toEqual({ type: 'create-and-greet' });
  });

  it('unknown user + /register foo → create+register', () => {
    expect(decideAction(mkUser(null), { kind: 'register', email: 'a@b.com' })).toEqual({
      type: 'create-and-register',
      email: 'a@b.com',
    });
  });

  it('unknown user + plain message → ignore', () => {
    expect(decideAction(mkUser(null), { kind: 'message' })).toEqual({ type: 'ignore' });
  });

  it('PENDING_EMAIL + plain message → nag once', () => {
    expect(decideAction(mkUser('PENDING_EMAIL'), { kind: 'message' })).toEqual({ type: 'nag-register' });
  });

  it('PENDING_EMAIL + /register → register', () => {
    expect(decideAction(mkUser('PENDING_EMAIL'), { kind: 'register', email: 'a@b.com' })).toEqual({
      type: 'register',
      email: 'a@b.com',
    });
  });

  it('PENDING_APPROVAL + plain message → ignore', () => {
    expect(decideAction(mkUser('PENDING_APPROVAL'), { kind: 'message' })).toEqual({ type: 'ignore' });
  });

  it('PENDING_APPROVAL + /register → reregister (replace email)', () => {
    expect(decideAction(mkUser('PENDING_APPROVAL'), { kind: 'register', email: 'a@b.com' })).toEqual({
      type: 'register',
      email: 'a@b.com',
    });
  });

  it('REJECTED + anything → ignore', () => {
    expect(decideAction(mkUser('REJECTED'), { kind: 'message' })).toEqual({ type: 'ignore' });
    expect(decideAction(mkUser('REJECTED'), { kind: 'register', email: 'a@b.com' })).toEqual({
      type: 'ignore',
    });
    expect(decideAction(mkUser('REJECTED'), { kind: 'start' })).toEqual({ type: 'ignore' });
  });

  it('APPROVED + plain message → forward', () => {
    expect(decideAction(mkUser('APPROVED'), { kind: 'message' })).toEqual({ type: 'forward' });
  });

  it('APPROVED + /start → already-set-up', () => {
    expect(decideAction(mkUser('APPROVED'), { kind: 'start' })).toEqual({ type: 'already-set-up' });
  });

  it('APPROVED + /register → cannot-change-email', () => {
    expect(decideAction(mkUser('APPROVED'), { kind: 'register', email: 'a@b.com' })).toEqual({
      type: 'cannot-change-email',
    });
  });
});
