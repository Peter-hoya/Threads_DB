import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decryptAccessToken,
  encryptAccessToken,
  getTokenEncryptionKey,
  tokenFingerprintMatches,
} from './token-crypto.js';

const key = Buffer.alloc(32, 7);

test('AES-256-GCM encrypts and decrypts a token with account-bound AAD', () => {
  const encrypted = encryptAccessToken(' secret-token ', 12, {
    key,
    iv: Buffer.alloc(12, 3),
  });

  assert.notEqual(encrypted.encryptedAccessToken, 'secret-token');
  assert.equal(decryptAccessToken(encrypted, 12, { key }), 'secret-token');
  assert.equal(tokenFingerprintMatches('secret-token', encrypted.tokenFingerprint), true);
});

test('ciphertext cannot be moved to a different account', () => {
  const encrypted = encryptAccessToken('secret-token', 12, { key });
  assert.throws(
    () => decryptAccessToken(encrypted, 13, { key }),
    /Unable to decrypt/,
  );
});

test('tampering is rejected by the GCM authentication tag', () => {
  const encrypted = encryptAccessToken('secret-token', 12, { key });
  const ciphertext = Buffer.from(encrypted.encryptedAccessToken, 'base64url');
  ciphertext[0] ^= 1;
  encrypted.encryptedAccessToken = ciphertext.toString('base64url');
  assert.throws(() => decryptAccessToken(encrypted, 12, { key }), /Unable to decrypt/);
});

test('deployment key must decode to exactly 32 bytes', () => {
  assert.deepEqual(
    getTokenEncryptionKey({ THREADS_TOKEN_ENCRYPTION_KEY: key.toString('base64') }),
    key,
  );
  assert.throws(
    () => getTokenEncryptionKey({ THREADS_TOKEN_ENCRYPTION_KEY: 'too-short' }),
    /exactly 32 bytes/,
  );
});
