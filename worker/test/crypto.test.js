import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { decryptAccessToken, parseEncryptionKey } from '../src/crypto.js';

function encrypt(token, key, accountId, iv = randomBytes(12)) {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`threads-account:${accountId}:v1`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    encryptedAccessToken: ciphertext.toString('base64url'),
    accessTokenIv: iv.toString('base64url'),
    accessTokenAuthTag: cipher.getAuthTag().toString('base64url'),
    encryptionVersion: 1,
    tokenFingerprint: createHash('sha256').update(token).digest('hex').slice(0, 16),
  };
}

test('decrypts an AES-256-GCM token using the versioned environment key', () => {
  const key = randomBytes(32);
  const credential = encrypt('THAA-secret-token', key, 17);
  const result = decryptAccessToken(credential, 17, {
    THREADS_TOKEN_ENCRYPTION_KEY: key.toString('base64'),
  });
  assert.equal(result, 'THAA-secret-token');
});

test('rejects the wrong key and malformed key sizes', () => {
  const key = randomBytes(32);
  const credential = encrypt('secret', key, 17);
  assert.throws(
    () => decryptAccessToken(credential, 17, {
      THREADS_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    }),
    /decryption failed/i,
  );
  assert.throws(
    () => decryptAccessToken(credential, 18, {
      THREADS_TOKEN_ENCRYPTION_KEY: key.toString('base64'),
    }),
    /decryption failed/i,
  );
  assert.throws(() => parseEncryptionKey(randomBytes(16).toString('base64')), /32 bytes/);
});
