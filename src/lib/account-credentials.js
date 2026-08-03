import prisma from '@/lib/db';
import { decryptAccessToken, encryptAccessToken } from '@/lib/token-crypto';

export const credentialPresenceSelect = {
  accountId: true,
};

const ACCOUNT_WRITE_FIELDS = new Set([
  'accountName',
  'description',
  'threadsAccessToken',
  'role',
  'postingEnabled',
  'timezone',
  'operatingStartMinute',
  'operatingEndMinute',
  'dailyPostLimit',
  'isActive',
]);

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function optionalString(value, field, maxLength, { nullable = true } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') throw validationError(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed && nullable) return null;
  if (!trimmed) throw validationError(`${field} is required.`);
  if (trimmed.length > maxLength) throw validationError(`${field} is too long.`);
  return trimmed;
}

function booleanValue(value, field) {
  if (typeof value !== 'boolean') throw validationError(`${field} must be a boolean.`);
  return value;
}

function integerValue(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw validationError(`${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function timezoneValue(value) {
  const timezone = optionalString(value, 'timezone', 100, { nullable: false });
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw validationError('timezone must be a valid IANA timezone.');
  }
  return timezone;
}

export function parseAccountWriteBody(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('A JSON object is required.');
  }

  const unknown = Object.keys(body).filter((key) => !ACCOUNT_WRITE_FIELDS.has(key));
  if (unknown.length) {
    throw validationError(`Unknown account fields: ${unknown.join(', ')}`);
  }

  const data = {};
  if ('accountName' in body) data.accountName = optionalString(body.accountName, 'accountName', 100, { nullable: false });
  if ('description' in body) data.description = optionalString(body.description, 'description', 2000);
  if ('role' in body) {
    if (!['primary', 'automation'].includes(body.role)) throw validationError('role must be primary or automation.');
    data.role = body.role;
  }
  if ('postingEnabled' in body) data.postingEnabled = booleanValue(body.postingEnabled, 'postingEnabled');
  if ('timezone' in body) data.timezone = timezoneValue(body.timezone);
  if ('operatingStartMinute' in body) data.operatingStartMinute = integerValue(body.operatingStartMinute, 'operatingStartMinute', 0, 1439);
  if ('operatingEndMinute' in body) data.operatingEndMinute = integerValue(body.operatingEndMinute, 'operatingEndMinute', 0, 1439);
  if ('dailyPostLimit' in body) data.dailyPostLimit = integerValue(body.dailyPostLimit, 'dailyPostLimit', 1, 100);
  if ('isActive' in body) data.isActive = booleanValue(body.isActive, 'isActive');

  let accessToken;
  if ('threadsAccessToken' in body) {
    if (body.threadsAccessToken === null) {
      accessToken = null;
    } else if (typeof body.threadsAccessToken !== 'string') {
      throw validationError('threadsAccessToken must be a string or null.');
    } else {
      const trimmed = body.threadsAccessToken.trim();
      if (trimmed.length > 8192) throw validationError('threadsAccessToken is too long.');
      accessToken = trimmed || undefined;
    }
  }

  if (!partial && !data.accountName) throw validationError('accountName is required.');
  if ((data.role ?? 'automation') === 'primary' && data.postingEnabled) {
    throw validationError('The primary account must remain manual (postingEnabled=false).');
  }

  return { data, accessToken };
}

export function sanitizeAccount(account) {
  if (!account) return account;

  const {
    credential,
    threadsAccessToken: legacyPlaintextToken,
    ...safeAccount
  } = account;

  const hasToken = Boolean(credential || legacyPlaintextToken);
  return {
    ...safeAccount,
    // Keep the old response shape without ever returning token material. The UI
    // uses _hasToken and sends a replacement only when the admin enters one.
    threadsAccessToken: null,
    _hasToken: hasToken,
    hasCredential: hasToken,
  };
}

export async function getAccountAccessToken(accountOrId, client = prisma) {
  const account = typeof accountOrId === 'object' && accountOrId !== null
    ? accountOrId
    : await client.account.findUnique({
      where: { id: Number(accountOrId) },
      include: { credential: true },
    });

  if (!account) return null;

  if (account.credential) {
    return decryptAccessToken(account.credential, account.id);
  }

  // Transitional fallback only. migrate-legacy-tokens.mjs encrypts and clears
  // this column; new writes never persist plaintext here.
  return account.threadsAccessToken || null;
}

export async function upsertAccountCredential(client, accountId, accessToken) {
  const id = Number(accountId);
  const encrypted = encryptAccessToken(accessToken, id);

  await client.accountCredential.upsert({
    where: { accountId: id },
    create: { accountId: id, ...encrypted },
    update: encrypted,
  });

  // Clearing the legacy column is part of the same transaction when this helper
  // receives a Prisma transaction client.
  await client.account.update({
    where: { id },
    data: { threadsAccessToken: null },
  });

  return encrypted.tokenFingerprint;
}

export async function deleteAccountCredential(client, accountId) {
  const id = Number(accountId);
  await client.accountCredential.deleteMany({ where: { accountId: id } });
  await client.account.update({
    where: { id },
    data: {
      threadsAccessToken: null,
      tokenStatus: 'missing',
      tokenType: null,
      tokenScopes: null,
      tokenExpiresAt: null,
      tokenLastRefreshedAt: null,
      tokenLastValidatedAt: null,
      oauthConnectedAt: null,
    },
  });
}

export async function verifyManualThreadsToken(accessToken, expectedUserId = null) {
  if (process.env.ALLOW_MANUAL_THREADS_TOKEN !== 'true') {
    const error = validationError('수동 토큰 입력은 비활성화되어 있습니다. 공식 OAuth 연결을 사용해주세요.');
    error.status = 403;
    throw error;
  }

  const response = await fetch('https://graph.threads.net/v1.0/me?fields=id,username', {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  const profile = await response.json().catch(() => ({}));
  if (!response.ok || !profile.id || !profile.username) {
    throw validationError('수동 Threads 토큰의 계정 소유자를 확인할 수 없습니다.');
  }
  if (expectedUserId && String(expectedUserId) !== String(profile.id)) {
    const error = validationError('입력한 토큰이 기존 Threads 계정과 일치하지 않습니다.');
    error.status = 409;
    throw error;
  }
  return { id: String(profile.id), username: String(profile.username) };
}
