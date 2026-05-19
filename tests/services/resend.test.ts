import { describe, expect, it, vi } from 'vitest';
import { FatalError, TransientError } from '../../src/lib/errors';
import { makeResendClient } from '../../src/services/resend';

function makeFakeResend(impl: any) {
  return { emails: { send: vi.fn().mockImplementation(impl) } };
}

const payload = {
  from: 'a@b.com',
  to: 'c@d.com',
  subject: 's',
  text: 't',
  html: '<p>t</p>',
  attachments: [],
};

describe('resend service', () => {
  it('sends and returns the message id', async () => {
    const fake = makeFakeResend(async () => ({ data: { id: 're-id-1' }, error: null }));
    const c = makeResendClient(fake as any);
    const id = await c.send(payload);
    expect(id).toBe('re-id-1');
  });

  // Resend's ErrorResponse only has { name, message } — no statusCode.
  // The wrapper maps name → status via the table mirrored from
  // RESEND_ERROR_CODES_BY_KEY in the SDK.
  it('maps Resend error name "application_error" (500) to TransientError', async () => {
    const fake = makeFakeResend(async () => ({
      data: null,
      error: { name: 'application_error', message: 'boom' },
    }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(TransientError);
  });

  it('maps Resend error name "internal_server_error" to TransientError', async () => {
    const fake = makeFakeResend(async () => ({
      data: null,
      error: { name: 'internal_server_error', message: 'oops' },
    }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(TransientError);
  });

  it('maps Resend error name "rate_limit_exceeded" to TransientError', async () => {
    const fake = makeFakeResend(async () => ({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'rate' },
    }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(TransientError);
  });

  it('maps Resend error name "invalid_parameter" (422) to FatalError', async () => {
    const fake = makeFakeResend(async () => ({
      data: null,
      error: { name: 'invalid_parameter', message: 'nope' },
    }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(FatalError);
  });

  it('maps Resend error name "missing_api_key" (401) to FatalError', async () => {
    const fake = makeFakeResend(async () => ({
      data: null,
      error: { name: 'missing_api_key', message: 'no key' },
    }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(FatalError);
  });

  it('unknown error name falls through to FatalError (safer default)', async () => {
    const fake = makeFakeResend(async () => ({
      data: null,
      error: { name: 'totally_new_error', message: 'who knows' },
    }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(FatalError);
  });

  // Thrown-error path: SDK errors with a `statusCode` property still flow
  // through the existing classify() helper.
  it('maps thrown 5xx errors (with statusCode) to TransientError', async () => {
    const err: any = new Error('boom');
    err.statusCode = 500;
    const fake = makeFakeResend(async () => {
      throw err;
    });
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(TransientError);
  });

  it('maps thrown 429 errors (with statusCode) to TransientError', async () => {
    const err: any = new Error('rate');
    err.statusCode = 429;
    const fake = makeFakeResend(async () => {
      throw err;
    });
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(TransientError);
  });
});
