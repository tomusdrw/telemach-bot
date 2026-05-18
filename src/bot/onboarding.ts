// src/bot/onboarding.ts
import { z } from 'zod';
import { UserRepo } from '../db/users';
import { decideAction } from './auth';

export interface NotifyAdminInput {
  telegramId: number;
  username: string | null;
  firstName: string | null;
  email: string;
}
export type NotifyAdmin = (input: NotifyAdminInput) => Promise<void>;

export interface OnboardingDeps {
  repo: UserRepo;
  notify: NotifyAdmin;
}

interface OnboardingDepsWithEmail extends OnboardingDeps {
  emailArg: string;
}

interface MinimalCtx {
  from?: { id: number; username?: string; first_name?: string };
  reply(text: string): Promise<unknown>;
}

const emailSchema = z.string().email();

function userView(repo: UserRepo, telegramId: number) {
  const u = repo.findById(telegramId);
  return u ? { telegramId: u.telegramId, status: u.status, isAdmin: u.isAdmin } : null;
}

export async function handleStart(ctx: MinimalCtx, deps: OnboardingDeps): Promise<void> {
  if (!ctx.from) return;
  const action = decideAction(userView(deps.repo, ctx.from.id), { kind: 'start' });
  switch (action.type) {
    case 'create-and-greet':
      deps.repo.upsertNew({
        telegramId: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      });
      await ctx.reply('Hi. Reply with /register your@email.com to get started.');
      return;
    case 'already-set-up':
      await ctx.reply("You're already set up.");
      return;
    case 'ignore':
      return;
    default:
      return;
  }
}

export async function handleRegister(
  ctx: MinimalCtx,
  deps: OnboardingDepsWithEmail
): Promise<void> {
  if (!ctx.from) return;
  const parsed = emailSchema.safeParse(deps.emailArg);
  if (!parsed.success) {
    await ctx.reply("That's not a valid email address. Try /register your@email.com");
    return;
  }
  const email = parsed.data;
  const action = decideAction(userView(deps.repo, ctx.from.id), { kind: 'register', email });
  switch (action.type) {
    case 'create-and-register':
      deps.repo.upsertNew({
        telegramId: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      });
      deps.repo.setEmail(ctx.from.id, email);
      await deps.notify({
        telegramId: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
        email,
      });
      await ctx.reply('Got it. Waiting for admin approval.');
      return;
    case 'register':
      deps.repo.setEmail(ctx.from.id, email);
      await deps.notify({
        telegramId: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
        email,
      });
      await ctx.reply('Got it. Waiting for admin approval.');
      return;
    case 'cannot-change-email':
      await ctx.reply("You're already set up. Email cannot be changed from here.");
      return;
    case 'ignore':
      return;
    default:
      return;
  }
}

export interface PlainMessageOutcome {
  forwardToApprovedFlow: boolean;
}

export async function handlePlainMessage(
  ctx: MinimalCtx,
  deps: OnboardingDeps
): Promise<PlainMessageOutcome> {
  if (!ctx.from) return { forwardToApprovedFlow: false };
  const action = decideAction(userView(deps.repo, ctx.from.id), { kind: 'message' });
  switch (action.type) {
    case 'forward':
      return { forwardToApprovedFlow: true };
    case 'nag-register':
      await ctx.reply('Please run /register your@email.com first.');
      return { forwardToApprovedFlow: false };
    default:
      return { forwardToApprovedFlow: false };
  }
}
