// src/services/preflight.ts
//
// Runs once at startup, after config parse, before bot.start(). Catches the
// most common deploy-time mistakes (bad API key, unverified Resend domain)
// with a clear log line, instead of waiting for the first real message to
// fail with a 💩 reaction and a less obvious log trail.
//
// The check is opt-out via SKIP_PREFLIGHT=true (set in tests or local dev
// where you want to start without hitting the network).

import { z } from 'zod';
import { logger } from '../lib/logger.js';

export interface PreflightOpts {
  openrouterApiKey: string;
  resendApiKey: string;
  resendFromEmail: string;
  fetchImpl?: typeof fetch;
}

export class PreflightError extends Error {
  readonly checks: string[];
  constructor(checks: string[]) {
    super(`preflight failed: ${checks.join('; ')}`);
    this.name = 'PreflightError';
    this.checks = checks;
  }
}

const openrouterAuthSchema = z.object({
  data: z.object({
    label: z.string().optional(),
    usage: z.number().optional(),
    limit: z.number().nullable().optional(),
  }),
});

const resendDomainsSchema = z.object({
  data: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
      }),
    )
    .optional(),
});

export async function runPreflight(opts: PreflightOpts): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const failures: string[] = [];

  // -------- OpenRouter -----------------------------------------------------
  // GET /api/v1/auth/key is authenticated and returns key metadata. A 401
  // means the key is wrong. Cheaper than spending tokens via /chat/completions.
  try {
    const r = await fetchImpl('https://openrouter.ai/api/v1/auth/key', {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.openrouterApiKey}` },
    });
    if (!r.ok) {
      failures.push(`openrouter: HTTP ${r.status} on /auth/key`);
    } else {
      const j = await r.json();
      const parsed = openrouterAuthSchema.safeParse(j);
      if (!parsed.success) {
        // shape unexpected — log warn but don't fail (OpenRouter may change shape)
        logger.warn({ json: j }, 'openrouter /auth/key returned unexpected shape; continuing');
      } else {
        logger.info({ usage: parsed.data.data.usage, limit: parsed.data.data.limit }, 'openrouter key OK');
      }
    }
  } catch (err) {
    failures.push(`openrouter: ${(err as Error).message}`);
  }

  // -------- Resend ---------------------------------------------------------
  // GET /domains lists the account's verified domains. We assert that the
  // domain part of RESEND_FROM_EMAIL is present AND has status === 'verified'.
  // First-deploy classic failure: setting RESEND_FROM_EMAIL before verifying.
  try {
    const r = await fetchImpl('https://api.resend.com/domains', {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.resendApiKey}` },
    });
    if (!r.ok) {
      failures.push(`resend: HTTP ${r.status} on /domains`);
    } else {
      const j = await r.json();
      const parsed = resendDomainsSchema.safeParse(j);
      if (!parsed.success || !parsed.data.data) {
        logger.warn({ json: j }, 'resend /domains returned unexpected shape; continuing');
      } else {
        const fromDomain = opts.resendFromEmail.split('@')[1]?.toLowerCase();
        if (!fromDomain) {
          failures.push(`resend: RESEND_FROM_EMAIL has no domain part`);
        } else {
          const match = parsed.data.data.find((d) => d.name.toLowerCase() === fromDomain);
          if (!match) {
            failures.push(
              `resend: domain '${fromDomain}' is not on the account (saw: ${parsed.data.data.map((d) => d.name).join(', ') || 'none'})`,
            );
          } else if (match.status !== 'verified') {
            failures.push(`resend: domain '${fromDomain}' status is '${match.status}', expected 'verified'`);
          } else {
            logger.info({ domain: fromDomain }, 'resend domain verified');
          }
        }
      }
    }
  } catch (err) {
    failures.push(`resend: ${(err as Error).message}`);
  }

  if (failures.length > 0) {
    throw new PreflightError(failures);
  }
}
