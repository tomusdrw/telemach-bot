import { type CreateEmailOptions, Resend } from 'resend';
import type { EmailPayload } from '../bot/email-composer.js';
import { FatalError, TransientError } from '../lib/errors.js';

export interface ResendSender {
  send(payload: EmailPayload): Promise<string>; // returns Resend message id
}

interface ProviderError {
  statusCode?: number;
  message?: string;
}

function classify(statusCode: number | undefined | null): 'transient' | 'fatal' {
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
        // RequireAtLeastOne<{react, html, text}> needs us to commit to a
        // branch; we always set both `html` and `text`, so build the payload
        // explicitly as CreateEmailOptions.
        const sendPayload: CreateEmailOptions = {
          from: p.from,
          to: p.to,
          subject: p.subject,
          html: p.html,
          text: p.text,
          attachments: p.attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
          })),
        };
        const result = await resend.emails.send(sendPayload);
        if (result.error) {
          // v6: ErrorResponse has a real `statusCode: number | null` field.
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
