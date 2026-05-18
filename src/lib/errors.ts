export interface ErrorContext {
  provider: 'whisper' | 'openrouter' | 'resend' | 'telegram' | 'db';
  detail?: unknown;
}

export class TransientError extends Error {
  readonly provider: ErrorContext['provider'];
  readonly detail: unknown;
  constructor(message: string, ctx: ErrorContext) {
    super(message);
    this.name = 'TransientError';
    this.provider = ctx.provider;
    this.detail = ctx.detail;
  }
}

export class FatalError extends Error {
  readonly provider: ErrorContext['provider'];
  readonly detail: unknown;
  constructor(message: string, ctx: ErrorContext) {
    super(message);
    this.name = 'FatalError';
    this.provider = ctx.provider;
    this.detail = ctx.detail;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RetryOptions {
  delaysMs: number[]; // e.g. [500, 2000, 8000]
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof TransientError) || attempt >= opts.delaysMs.length) {
        throw err;
      }
      await sleep(opts.delaysMs[attempt]!);
      attempt += 1;
    }
  }
}
