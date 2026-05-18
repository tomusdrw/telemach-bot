// src/index.ts
import 'dotenv/config';
import { buildBot } from './bot/index';
import { parseConfig } from './config';
import { openDatabase } from './db/index';
import { UserRepo } from './db/users';
import { configureLogger, logger } from './lib/logger';

async function main(): Promise<void> {
  const config = parseConfig(process.env as Record<string, string | undefined>);
  configureLogger({ level: config.logLevel });
  const db = openDatabase(config.dbPath);
  const repo = new UserRepo(db);
  repo.seedAdmin({ telegramId: config.adminTelegramUserId, email: config.adminEmail });

  const bot = buildBot(config, repo);

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
    onStart: (botInfo) => logger.info({ bot: botInfo.username }, 'bot online'),
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'bot failed to start');
  process.exit(1);
});
