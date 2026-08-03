import { DeferredError, PermanentError } from './errors.js';

function localMinute(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

export function nextOperatingTime(account, now = new Date()) {
  const start = Number(account.operatingStartMinute);
  const end = Number(account.operatingEndMinute);
  const minute = localMinute(now, account.timezone || 'Asia/Seoul');

  if (start === end) return null;
  const allowed = start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
  if (allowed) return null;

  const minutesUntilStart = minute < start ? start - minute : 1440 - minute + start;
  return new Date(now.getTime() + Math.max(1, minutesUntilStart) * 60_000);
}

export function nextDayOperatingTime(account, now = new Date()) {
  const start = Number(account.operatingStartMinute);
  const minute = localMinute(now, account.timezone || 'Asia/Seoul');
  return new Date(now.getTime() + (1440 - minute + start) * 60_000);
}

export function assertAccountCanPublish(account, now = new Date(), { ignoreWindow = false } = {}) {
  if (!account) throw new PermanentError('Job has no account.', { code: 'ACCOUNT_MISSING' });
  if (account.role !== 'automation') {
    throw new PermanentError('Primary/manual accounts cannot be published by the worker.', {
      code: 'PRIMARY_ACCOUNT_BLOCKED',
    });
  }
  if (!account.isActive || !account.postingEnabled) {
    throw new PermanentError('Account automatic posting is disabled.', {
      code: 'ACCOUNT_POSTING_DISABLED',
    });
  }
  if (!account.credential) {
    throw new PermanentError('Account has no encrypted Threads credential.', {
      code: 'ACCOUNT_CREDENTIAL_MISSING',
    });
  }
  if (!account.threadsUserId) {
    throw new PermanentError('Account has no OAuth-verified Threads user ID.', {
      code: 'ACCOUNT_THREADS_ID_MISSING',
    });
  }
  if (!['active', 'expiring'].includes(account.tokenStatus)) {
    throw new PermanentError(`Account token status is ${account.tokenStatus || 'missing'}.`, {
      code: 'ACCOUNT_TOKEN_INACTIVE',
    });
  }
  if (account.tokenExpiresAt && account.tokenExpiresAt <= now) {
    throw new PermanentError('Account token is expired.', { code: 'ACCOUNT_TOKEN_EXPIRED' });
  }

  const runAt = ignoreWindow ? null : nextOperatingTime(account, now);
  if (runAt) {
    throw new DeferredError('Outside the account operating window.', runAt, {
      code: 'OUTSIDE_OPERATING_WINDOW',
    });
  }
}
