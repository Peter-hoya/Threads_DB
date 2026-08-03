import { hostname } from 'node:os';

function integer(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function boolean(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig() {
  const threadsApiBaseUrl = process.env.THREADS_API_BASE_URL || 'https://graph.threads.net/v1.0';
  const parsedApiUrl = new URL(threadsApiBaseUrl);
  if (parsedApiUrl.protocol !== 'https:' || parsedApiUrl.hostname !== 'graph.threads.net') {
    throw new Error('THREADS_API_BASE_URL must use the official https://graph.threads.net host.');
  }

  const leaseTimeoutMs = integer('LEASE_TIMEOUT_MS', 120_000, { min: 30_000, max: 900_000 });
  return Object.freeze({
    workerId: process.env.WORKER_ID || `${hostname()}:${process.pid}`,
    threadsApiBaseUrl,
    apiTimeoutMs: integer('API_TIMEOUT_MS', 30_000, { min: 1_000, max: 120_000 }),
    pollIntervalMs: integer('POLL_INTERVAL_MS', 5_000, { min: 250, max: 300_000 }),
    leaseTimeoutMs,
    leaseHeartbeatMs: integer('LEASE_HEARTBEAT_MS', Math.floor(leaseTimeoutMs / 3), {
      min: 5_000,
      max: Math.max(5_000, leaseTimeoutMs - 1_000),
    }),
    processHeartbeatMs: integer('PROCESS_HEARTBEAT_MS', 30_000, { min: 5_000, max: 300_000 }),
    retryBaseMs: integer('RETRY_BASE_MS', 30_000, { min: 1_000, max: 3_600_000 }),
    retryMaxMs: integer('RETRY_MAX_MS', 6 * 60 * 60 * 1000, { min: 1_000, max: 24 * 60 * 60 * 1000 }),
    contentReuseCooldownDays: integer('CONTENT_REUSE_COOLDOWN_DAYS', 90, { min: 1, max: 3650 }),
    dryRun: boolean('DRY_RUN', false),
    dryRunOnce: boolean('DRY_RUN_ONCE', true),
    shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', 30_000, { min: 1_000, max: 120_000 }),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || null,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
    alertOnRetry: boolean('ALERT_ON_RETRY', false),
  });
}
