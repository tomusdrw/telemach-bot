// src/bot/timezone-cmd.ts
import type { UserRepo } from '../db/users';

export interface TimezoneCmdCtx {
  from?: { id: number };
  match: string | RegExpMatchArray;
  reply(text: string): Promise<unknown>;
}

export interface TimezoneCmdDeps {
  repo: UserRepo;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function handleTimezoneCommand(ctx: TimezoneCmdCtx, deps: TimezoneCmdDeps): Promise<void> {
  if (!ctx.from) return;
  const user = deps.repo.findById(ctx.from.id);
  if (!user || user.status !== 'APPROVED') return;

  const arg = String(ctx.match ?? '').trim();
  if (arg === '') {
    await ctx.reply(`Your timezone: ${user.timezone}`);
    return;
  }

  if (!isValidTimezone(arg)) {
    await ctx.reply("Unknown timezone. Use an IANA name like 'Europe/Warsaw' or 'America/New_York'.");
    return;
  }

  const from = user.timezone;
  deps.repo.updateTimezone(user.telegramId, arg);
  deps.repo.logAudit({
    telegramId: user.telegramId,
    chatMessageId: null,
    event: 'timezone_changed',
    details: JSON.stringify({ from, to: arg }),
  });
  await ctx.reply(`Timezone updated: ${arg}`);
}
