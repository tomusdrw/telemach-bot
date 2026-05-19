import { describe, expect, it, vi } from 'vitest';
import { PreflightError, runPreflight } from '../../src/services/preflight.js';

function makeFetch(responses: Record<string, { ok: boolean; status: number; body: unknown }>) {
  return vi.fn().mockImplementation(async (url: string) => {
    const matchKey = Object.keys(responses).find((k) => url.includes(k));
    if (!matchKey) throw new Error(`unmocked URL: ${url}`);
    const r = responses[matchKey]!;
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
    };
  });
}

const baseOpts = {
  openrouterApiKey: 'or-k',
  resendApiKey: 're-k',
  resendFromEmail: 'bot@example.com',
};

describe('runPreflight', () => {
  it('passes when both providers return OK and the from-domain is verified', async () => {
    const fetchImpl = makeFetch({
      'openrouter.ai/api/v1/auth/key': {
        ok: true,
        status: 200,
        body: { data: { label: 'main', usage: 0, limit: null } },
      },
      'api.resend.com/domains': {
        ok: true,
        status: 200,
        body: { data: [{ name: 'example.com', status: 'verified' }] },
      },
    });
    await expect(runPreflight({ ...baseOpts, fetchImpl })).resolves.toBeUndefined();
  });

  it('fails when OpenRouter returns 401', async () => {
    const fetchImpl = makeFetch({
      'openrouter.ai/api/v1/auth/key': { ok: false, status: 401, body: {} },
      'api.resend.com/domains': {
        ok: true,
        status: 200,
        body: { data: [{ name: 'example.com', status: 'verified' }] },
      },
    });
    await expect(runPreflight({ ...baseOpts, fetchImpl })).rejects.toBeInstanceOf(PreflightError);
    await expect(runPreflight({ ...baseOpts, fetchImpl })).rejects.toThrow(/openrouter.*401/i);
  });

  it('fails when Resend domain is missing from the account', async () => {
    const fetchImpl = makeFetch({
      'openrouter.ai/api/v1/auth/key': { ok: true, status: 200, body: { data: { usage: 0 } } },
      'api.resend.com/domains': {
        ok: true,
        status: 200,
        body: { data: [{ name: 'other.com', status: 'verified' }] },
      },
    });
    await expect(runPreflight({ ...baseOpts, fetchImpl })).rejects.toThrow(/is not on the account/i);
  });

  it('fails when Resend domain exists but is not verified', async () => {
    const fetchImpl = makeFetch({
      'openrouter.ai/api/v1/auth/key': { ok: true, status: 200, body: { data: { usage: 0 } } },
      'api.resend.com/domains': {
        ok: true,
        status: 200,
        body: { data: [{ name: 'example.com', status: 'pending' }] },
      },
    });
    await expect(runPreflight({ ...baseOpts, fetchImpl })).rejects.toThrow(/status is 'pending'/);
  });

  it('fails when Resend returns 401', async () => {
    const fetchImpl = makeFetch({
      'openrouter.ai/api/v1/auth/key': { ok: true, status: 200, body: { data: { usage: 0 } } },
      'api.resend.com/domains': { ok: false, status: 401, body: {} },
    });
    await expect(runPreflight({ ...baseOpts, fetchImpl })).rejects.toThrow(/resend.*401/i);
  });

  it('aggregates multiple failures into one PreflightError', async () => {
    const fetchImpl = makeFetch({
      'openrouter.ai/api/v1/auth/key': { ok: false, status: 401, body: {} },
      'api.resend.com/domains': { ok: false, status: 401, body: {} },
    });
    const err = await runPreflight({ ...baseOpts, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(PreflightError);
    expect((err as PreflightError).checks).toHaveLength(2);
  });

  it('treats network errors as failures (not exceptions)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENETUNREACH'));
    const err = await runPreflight({ ...baseOpts, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(PreflightError);
    expect((err as PreflightError).checks.length).toBeGreaterThan(0);
  });

  it('tolerates unexpected response shapes without failing', async () => {
    const fetchImpl = makeFetch({
      'openrouter.ai/api/v1/auth/key': { ok: true, status: 200, body: { something_else: true } },
      'api.resend.com/domains': {
        ok: true,
        status: 200,
        body: { data: [{ name: 'example.com', status: 'verified' }] },
      },
    });
    // openrouter shape is unexpected but doesn't fail the check (logger.warn only)
    await expect(runPreflight({ ...baseOpts, fetchImpl })).resolves.toBeUndefined();
  });
});
