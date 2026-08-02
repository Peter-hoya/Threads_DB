import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { PermanentError } from './errors.js';

function decodeCredentialField(value, fieldName) {
  if (!value) throw new PermanentError(`${fieldName} is missing.`, { code: 'TOKEN_DATA_MISSING' });

  const text = String(value).trim();
  try {
    const decoded = Buffer.from(text, 'base64url');
    if (decoded.length === 0) throw new Error('decoded value is empty');
    return decoded;
  } catch (error) {
    throw new PermanentError(`${fieldName} is not valid base64url.`, {
      code: 'TOKEN_DATA_INVALID',
      cause: error,
    });
  }
}

export function parseEncryptionKey(value, variableName = 'TOKEN_ENCRYPTION_KEY_V1') {
  if (!value) {
    throw new PermanentError(`${variableName} is missing.`, { code: 'TOKEN_KEY_MISSING' });
  }
  const text = String(value).trim();
  const key = /^[0-9a-fA-F]{64}$/.test(text)
    ? Buffer.from(text, 'hex')
    : Buffer.from(text, text.includes('-') || text.includes('_') ? 'base64url' : 'base64');
  if (key.length !== 32) {
    throw new PermanentError(`${variableName} must decode to exactly 32 bytes.`, {
      code: 'TOKEN_KEY_INVALID',
    });
  }
  return key;
}

export function decryptAccessToken(credential, accountId, env = process.env) {
  if (!credential) {
    throw new PermanentError('Account credential is not configured.', { code: 'TOKEN_NOT_CONFIGURED' });
  }

  const keyVersion = Number(credential.encryptionVersion || 1);
  if (!Number.isInteger(Number(accountId)) || Number(accountId) <= 0) {
    throw new PermanentError('A valid accountId is required for token decryption.', {
      code: 'TOKEN_ACCOUNT_ID_INVALID',
    });
  }
  const variableName = `TOKEN_ENCRYPTION_KEY_V${keyVersion}`;
  const canonicalValue = keyVersion === 1 ? env.THREADS_TOKEN_ENCRYPTION_KEY : null;
  const selectedName = canonicalValue ? 'THREADS_TOKEN_ENCRYPTION_KEY' : variableName;
  const key = parseEncryptionKey(canonicalValue || env[variableName], selectedName);
  const iv = decodeCredentialField(credential.accessTokenIv, 'credential.accessTokenIv');
  const authTag = decodeCredentialField(credential.accessTokenAuthTag, 'credential.accessTokenAuthTag');
  const ciphertext = decodeCredentialField(credential.encryptedAccessToken, 'credential.encryptedAccessToken');

  if (iv.length !== 12) {
    throw new PermanentError('credential.accessTokenIv must decode to 12 bytes for AES-256-GCM.', {
      code: 'TOKEN_IV_INVALID',
    });
  }
  if (authTag.length !== 16) {
    throw new PermanentError('credential.accessTokenAuthTag must decode to 16 bytes for AES-256-GCM.', {
      code: 'TOKEN_TAG_INVALID',
    });
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(`threads-account:${Number(accountId)}:v${keyVersion}`, 'utf8'));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const token = plaintext.toString('utf8');
    if (!token) throw new Error('decrypted token is empty');
    if (credential.tokenFingerprint) {
      const actual = Buffer.from(createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16));
      const expected = Buffer.from(String(credential.tokenFingerprint));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new Error('token fingerprint mismatch');
      }
    }
    return token;
  } catch (error) {
    throw new PermanentError('Access token decryption failed.', {
      code: 'TOKEN_DECRYPTION_FAILED',
      cause: error,
    });
  }
}
