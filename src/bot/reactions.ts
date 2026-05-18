import { logger } from '../lib/logger';

export interface ReactCtx {
  react(emoji: string): Promise<unknown>;
}

async function safeReact(ctx: ReactCtx, emoji: string): Promise<void> {
  try {
    await ctx.react(emoji);
  } catch (err) {
    logger.warn({ err, emoji }, 'failed to set reaction (ignored)');
  }
}

export const markReceived = (ctx: ReactCtx) => safeReact(ctx, '👀');
export const markWorking  = (ctx: ReactCtx) => safeReact(ctx, '✍');
export const markDone     = (ctx: ReactCtx) => safeReact(ctx, '👍');
export const markFailed   = (ctx: ReactCtx) => safeReact(ctx, '💩');
