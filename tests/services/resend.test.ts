import { describe, expect, it, vi } from 'vitest';
import { FatalError, TransientError } from '../../src/lib/errors.js';
import { makeResendClient } from '../../src/services/resend.js';

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

  // v6 ErrorResponse: { message, name, statusCode: number | null }
  // The wrapper reads statusCode directly.
  it('maps Resend error with 5xx statusCode to TransientError', async () => {
    const fake = makeFakeResend(async () => ({
      data: null,
      error: { name: 'application_error', message: 'boom', statusCode: 500 },
    }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(TransientError);
  });

  it('maps Resend error with 429 statusCode to TransientError', async () => {
    const fake = makeFakeResend(async () => ({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'rate', statusCode: 429 },
    }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(TransientError);
  });

  it('maps Resend error with 4xx statusCode to FatalError', async () => {
    const fake = makeFakeResend(async () => ({
      data: null,
      error: { name: 'invalid_parameter', message: 'nope', statusCode: 422 },
    }));
    const c = makeResendClient(fake as any);
    await expect(c.send(payload)).rejects.toBeInstanceOf(FatalError);
  });

  it('maps Resend error with null statusCode to FatalError (safer default)', async () => {
    const fake = makeFakeResend(async () => ({
      data: null,
      error: { name: 'validation_error', message: 'who knows', statusCode: null },
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

  it('forwards attachment contentType to Resend SDK when present', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'r-1' }, error: null });
    const sender = makeResendClient({ emails: { send } } as any);
    await sender.send({
      from: 'a@x.com',
      to: 'b@x.com',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
      attachments: [
        {
          filename: 'event.ics',
          content: Buffer.from('x'),
          contentType: 'text/calendar; method=PUBLISH; charset=UTF-8',
        },
      ],
    });
    expect(send).toHaveBeenCalledTimes(1);
    const sentPayload = send.mock.calls[0][0];
    expect(sentPayload.attachments[0]).toMatchObject({
      filename: 'event.ics',
      contentType: 'text/calendar; method=PUBLISH; charset=UTF-8',
    });
  });
});
