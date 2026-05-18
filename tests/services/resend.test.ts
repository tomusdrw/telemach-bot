import { describe, it, expect, vi } from 'vitest';
import { makeResendClient } from '../../src/services/resend';
import { FatalError, TransientError } from '../../src/lib/errors';

function makeFakeResend(impl: any) {
  return { emails: { send: vi.fn().mockImplementation(impl) } };
}

const payload = {
  from: 'a@b.com', to: 'c@d.com', subject: 's',
  text: 't', html: '<p>t</p>', attachments: [],
};

describe('resend service', () => {
  it('sends and returns the message id', async () => {
    const fake = makeFakeResend(async () => ({ data: { id: 're-id-1' }, error: null }));
    const c = makeResendClient(fake as any);
    const id = await c.send(payload);
    expect(id).toBe('re-id-1');
  });

  it('maps Resend error object with retryable status to TransientError', async () => {
    const fake = makeFakeResend(async () => ({ data: null, error: { name: 'x', message: 'm', statusCode: 503 } }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(TransientError);
  });

  it('maps Resend error object with 4xx to FatalError', async () => {
    const fake = makeFakeResend(async () => ({ data: null, error: { name: 'x', message: 'm', statusCode: 400 } }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(FatalError);
  });

  it('maps thrown 5xx errors to TransientError', async () => {
    const err: any = new Error('boom');
    err.statusCode = 500;
    const fake = makeFakeResend(async () => { throw err; });
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(TransientError);
  });

  it('maps Resend error object with 429 to TransientError', async () => {
    const fake = makeFakeResend(async () => ({ data: null, error: { name: 'x', message: 'rate', statusCode: 429 } }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(TransientError);
  });

  it('maps thrown 429 errors to TransientError', async () => {
    const err: any = new Error('rate');
    err.statusCode = 429;
    const fake = makeFakeResend(async () => { throw err; });
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(TransientError);
  });
});
