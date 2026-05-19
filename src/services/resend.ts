import { type CreateEmailOptions, type ErrorResponse, Resend } from 'resend';
import type { EmailPayload } from '../bot/email-composer';
import { FatalError, TransientError } from '../lib/errors';

export interface ResendSender {
  send(payload: EmailPayload): Promise<string>; // returns Resend message id
}

interface ProviderError {
  statusCode?: number;
  message?: string;
}

// Mirrors RESEND_ERROR_CODES_BY_KEY in the SDK (declared but not exported at
// runtime). Kept in sync manually with `node_modules/resend/dist/index.d.ts`.
// If the SDK adds a new code, classify() will fall through to 'fatal', which
// is the safer default.
const ERROR_STATUS_BY_NAME: Record<string, number> = {
  missing_required_field: 422,
  invalid_access: 422,
  invalid_parameter: 422,
  invalid_region: 422,
  rate_limit_exceeded: 429,
  missing_api_key: 401,
  invalid_api_Key: 403,
  invalid_from_address: 403,
  validation_error: 403,
  not_found: 404,
  method_not_allowed: 405,
  application_error: 500,
  internal_server_error: 500,
};

function classify(statusCode: number | undefined): 'transient' | 'fatal' {
  if (statusCode && (statusCode === 429 || statusCode >= 500)) return 'transient';
  return 'fatal';
}

function classifyByError(err: ErrorResponse): 'transient' | 'fatal' {
  return classify(ERROR_STATUS_BY_NAME[err.name]);
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
          const cls = classifyByError(result.error);
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
