import { Resend } from 'resend';
import type { EmailPayload } from '../bot/email-composer';
import { FatalError, TransientError } from '../lib/errors';

export interface ResendSender {
  send(payload: EmailPayload): Promise<string>; // returns Resend message id
}

interface ProviderError {
  statusCode?: number;
  message?: string;
}

function classify(statusCode: number | undefined): 'transient' | 'fatal' {
  if (statusCode && (statusCode === 429 || statusCode >= 500)) return 'transient';
  return 'fatal';
}

function asProviderError(err: unknown): ProviderError {
  if (typeof err !== 'object' || err === null) return {};
  const e = err as Record<string, unknown>;
  return {
    statusCode: typeof e.statusCode === 'number' ? e.statusCode : undefined,
    message: typeof e.message === 'string' ? e.message : undefined,
  };
}

export function makeResendClient(resend: Resend): ResendSender {
  return {
    async send(p) {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Resend v3 overloads conflict with EmailPayload, tracked in #2
        const result = await (resend.emails.send as any)({
          from: p.from,
          to: p.to,
          subject: p.subject,
          text: p.text,
          html: p.html,
          attachments: p.attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
          })),
        });
        if (result.error) {
          const cls = classify(result.error.statusCode);
          const Cls = cls === 'transient' ? TransientError : FatalError;
          throw new Cls(`resend: ${result.error.message}`, {
            provider: 'resend',
            detail: result.error,
          });
        }
        return result.data?.id ?? '';
      } catch (err) {
        if (err instanceof TransientError || err instanceof FatalError) throw err;
        const pe = asProviderError(err);
        const cls = classify(pe.statusCode);
        const Cls = cls === 'transient' ? TransientError : FatalError;
        throw new Cls(`resend: ${pe.message ?? 'unknown'}`, {
          provider: 'resend',
          detail: err,
        });
      }
    },
  };
}

export function defaultResendClient(apiKey: string): Resend {
  return new Resend(apiKey);
}
