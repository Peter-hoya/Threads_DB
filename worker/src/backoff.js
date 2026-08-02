const DEFAULT_BASE_MS = 30_000;
const DEFAULT_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * Full-jitter exponential backoff. `attempt` starts at 1 after the first lease.
 * A supplied Retry-After value is treated as the minimum safe delay.
 */
export function calculateBackoffMs({
  attempt,
  retryAfterMs = null,
  baseMs = DEFAULT_BASE_MS,
  maxMs = DEFAULT_MAX_MS,
  random = Math.random,
}) {
  const safeAttempt = Math.max(1, Number(attempt) || 1);
  const cap = Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
  const jittered = Math.floor(random() * cap);
  const retryFloor = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0;
  return Math.min(maxMs, Math.max(jittered, retryFloor));
}

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));

  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}
