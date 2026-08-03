import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ENCRYPTION_VERSION = 1;

function decodeKey(encodedKey) {
  if (typeof encodedKey !== 'string' || !encodedKey.trim()) {
    throw new Error('THREADS_TOKEN_ENCRYPTION_KEY is required.');
  }

  const value = encodedKey.trim();
  let key;

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex');
  } else {
    // A 32-byte base64/base64url secret is preferred for deployment env vars.
    key = Buffer.from(value, value.includes('-') || value.includes('_') ? 'base64url' : 'base64');
  }

  if (key.length !== KEY_BYTES) {
    throw new Error('THREADS_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }

  return key;
}

export function getTokenEncryptionKey(env = process.env) {
  return decodeKey(env.THREADS_TOKEN_ENCRYPTION_KEY);
}

function accountAad(accountId, version = ENCRYPTION_VERSION) {
  const numericAccountId = Number(accountId);
  if (!Number.isSafeInteger(numericAccountId) || numericAccountId <= 0) {
    throw new TypeError('A positive accountId is required for token encryption.');
  }
  return Buffer.from(`threads-account:${numericAccountId}:v${version}`, 'utf8');
}

export function fingerprintToken(token) {
  if (typeof token !== 'string' || !token) return null;
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}

export function encryptAccessToken(token, accountId, options = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new TypeError('A non-empty Threads access token is required.');
  }

  const key = options.key ?? getTokenEncryptionKey(options.env);
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError('Token encryption key must be a 32-byte Buffer.');
  }

  const iv = options.iv ?? randomBytes(IV_BYTES);
  if (!Buffer.isBuffer(iv) || iv.length !== IV_BYTES) {
    throw new TypeError('AES-GCM IV must be a 12-byte Buffer.');
  }

  const plaintext = token.trim();
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
  cipher.setAAD(accountAad(accountId));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return {
    encryptedAccessToken: ciphertext.toString('base64url'),
    accessTokenIv: iv.toString('base64url'),
    accessTokenAuthTag: cipher.getAuthTag().toString('base64url'),
    encryptionVersion: ENCRYPTION_VERSION,
    tokenFingerprint: fingerprintToken(plaintext),
  };
}

export function decryptAccessToken(credential, accountId, options = {}) {
  if (!credential) return null;

  const version = Number(credential.encryptionVersion);
  if (version !== ENCRYPTION_VERSION) {
    throw new Error(`Unsupported token encryption version: ${credential.encryptionVersion}`);
  }

  const key = options.key ?? getTokenEncryptionKey(options.env);
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError('Token encryption key must be a 32-byte Buffer.');
  }

  try {
    const iv = Buffer.from(credential.accessTokenIv, 'base64url');
    const authTag = Buffer.from(credential.accessTokenAuthTag, 'base64url');
    const ciphertext = Buffer.from(credential.encryptedAccessToken, 'base64url');

    if (iv.length !== IV_BYTES || authTag.length !== 16 || ciphertext.length === 0) {
      throw new Error('Malformed encrypted token.');
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
    decipher.setAAD(accountAad(accountId, version));
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    const safeError = new Error('Unable to decrypt the Threads access token.');
    safeError.cause = error;
    throw safeError;
  }
}

export function tokenFingerprintMatches(token, expectedFingerprint) {
  if (!token || !expectedFingerprint) return false;
  const actual = Buffer.from(fingerprintToken(token), 'utf8');
  const expected = Buffer.from(String(expectedFingerprint), 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

