// src/bot/timezone-cmd.ts
import type { UserRepo } from '../db/users';

export interface TimezoneCmdCtx {
  from?: { id: number };
  reply(text: string): Promise<unknown>;
}

export interface TimezoneCmdDeps {
  repo: UserRepo;
}

function canonicalizeTimezone(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export async function handleTimezoneCommand(
  ctx: TimezoneCmdCtx,
  arg: string,
  deps: TimezoneCmdDeps,
): Promise<void> {
  if (!ctx.from) return;
  const user = deps.repo.findById(ctx.from.id);
  if (!user || user.status !== 'APPROVED') return;

  if (arg.trim() === '') {
    await ctx.reply(`Your timezone: ${user.timezone}`);
    return;
  }

  const canonical = canonicalizeTimezone(arg);
  if (canonical === null) {
    await ctx.reply("Unknown timezone. Use an IANA name like 'Europe/Warsaw' or 'America/New_York'.");
    return;
  }

  const from = user.timezone;
  deps.repo.updateTimezone(user.telegramId, canonical);
  deps.repo.logAudit({
    telegramId: user.telegramId,
    chatMessageId: null,
    event: 'timezone_changed',
    details: JSON.stringify({ from, to: canonical }),
  });
  await ctx.reply(`Timezone updated: ${canonical}`);
}
