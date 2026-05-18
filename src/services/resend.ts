import { Resend } from 'resend';
import { FatalError, TransientError } from '../lib/errors';
import type { EmailPayload } from '../bot/email-composer';

export interface ResendSender {
  send(payload: EmailPayload): Promise<string>; // returns Resend message id
}

function classify(statusCode: number | undefined): 'transient' | 'fatal' {
  if (statusCode && statusCode >= 500) return 'transient';
  return 'fatal';
}

export function makeResendClient(resend: Resend): ResendSender {
  return {
    async send(p) {
      try {
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
      } catch (err: any) {
        if (err instanceof TransientError || err instanceof FatalError) throw err;
        const cls = classify(err?.statusCode);
        const Cls = cls === 'transient' ? TransientError : FatalError;
        throw new Cls(`resend: ${err?.message ?? 'unknown'}`, {
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
