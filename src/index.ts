// src/index.ts
import 'dotenv/config';
import { buildBot } from './bot/index.js';
import { parseConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { UserRepo } from './db/users.js';
import { configureLogger, logger } from './lib/logger.js';

async function main(): Promise<void> {
  const config = parseConfig(process.env as Record<string, string | undefined>);
  configureLogger({ level: config.logLevel });

  const db = openDatabase(config.dbPath);
  const repo = new UserRepo(db);
  repo.seedAdmin({ telegramId: config.adminTelegramUserId, email: config.adminEmail });

  const { bot, forward } = buildBot(config, repo);

  const stop = async (signal: string) => {
    logger.info({ signal }, 'stopping bot');
    await bot.stop();
    // Drain in-flight media groups so their flush callbacks don't fire after
    // the DB is closed and so the next start doesn't have to replay them.
    try {
      await forward.drain();
    } catch (err) {
      logger.warn({ err }, 'drain on shutdown failed');
    }
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
