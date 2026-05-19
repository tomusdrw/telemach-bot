import { logger } from '../lib/logger';

// Emojis that grammy's Context.react accepts natively (subset of Telegram's reaction list).
type NativeReactionEmoji = '👀' | '✍' | '👍' | '💩';

// Our broader set — 📅 isn't a Telegram message reaction, but we set it via the same code path.
export type ReactionEmoji = NativeReactionEmoji | '📅';

export interface ReactCtx {
  react(emoji: NativeReactionEmoji): Promise<unknown>;
}

async function safeReact(ctx: ReactCtx, emoji: ReactionEmoji): Promise<void> {
  try {
    await (ctx.react as (e: string) => Promise<unknown>)(emoji);
  } catch (err) {
    logger.warn({ err, emoji }, 'failed to set reaction (ignored)');
  }
}

export const markReceived = (ctx: ReactCtx) => safeReact(ctx, '👀');
export const markWorking = (ctx: ReactCtx) => safeReact(ctx, '✍');
export const markDone = (ctx: ReactCtx) => safeReact(ctx, '👍');
export const markFailed = (ctx: ReactCtx) => safeReact(ctx, '💩');
export const markEventAttached = (ctx: ReactCtx) => safeReact(ctx, '📅');
