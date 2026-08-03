import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { PublishProcessor } from './processor.js';
import { WorkerRepository } from './repository.js';
import { TelegramNotifier } from './telegram.js';
import { ThreadsClient } from './threads-client.js';
import { PublishWorker } from './worker.js';

const logger = createLogger();
let repository;

try {
  const config = loadConfig();
  repository = new WorkerRepository();
  const threadsClient = new ThreadsClient({
    baseUrl: config.threadsApiBaseUrl,
    requestTimeoutMs: config.apiTimeoutMs,
  });
  const notifier = new TelegramNotifier({
    botToken: config.telegramBotToken,
    chatId: config.telegramChatId,
    logger,
  });
  const processor = new PublishProcessor({
    repository,
    threadsClient,
    workerId: config.workerId,
    contentReuseCooldownDays: config.contentReuseCooldownDays,
    logger,
  });
  const worker = new PublishWorker({ repository, processor, notifier, config, logger });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      logger.info('shutdown_requested', { signal });
      worker.requestStop();
    });
  }

  await worker.run();
} catch (error) {
  logger.error('worker_fatal', error);
  process.exitCode = 1;
} finally {
  await repository?.disconnect().catch((error) => logger.error('database_disconnect_failed', error));
}
