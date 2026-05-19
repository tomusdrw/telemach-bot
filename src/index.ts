// src/index.ts
import 'dotenv/config';
import { buildBot } from './bot/index';
import { parseConfig } from './config';
import { openDatabase } from './db/index';
import { UserRepo } from './db/users';
import { configureLogger, logger } from './lib/logger';
import { runPreflight } from './services/preflight';

async function main(): Promise<void> {
  const config = parseConfig(process.env as Record<string, string | undefined>);
  configureLogger({ level: config.logLevel });

  if (process.env.SKIP_PREFLIGHT !== 'true') {
    await runPreflight({
      openrouterApiKey: config.openrouterApiKey,
      resendApiKey: config.resendApiKey,
      resendFromEmail: config.resendFromEmail,
    });
    logger.info('preflight checks passed');
  } else {
    logger.warn('SKIP_PREFLIGHT=true; provider credentials not verified');
  }

  const db = openDatabase(config.dbPath);
  const repo = new UserRepo(db);
  repo.seedAdmin({ telegramId: config.adminTelegramUserId, email: config.adminEmail });

  const { bot, forward } = buildBot(config, repo);

  const stop = async (signal: string) => {
    logger.info({ signal }, 'stopping bot');
    await bot.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  logger.info({ admin: config.adminTelegramUserId }, 'starting bot (long polling)');
  await bot.start({
    allowed_updates: ['message', 'callback_query'],
    onStart: async (botInfo) => {
      logger.info({ bot: botInfo.username }, 'bot online');
      await forward.replayPending();
    },
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'bot failed to start');
  process.exit(1);
});
