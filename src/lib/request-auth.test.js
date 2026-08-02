import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticateAdminRequest,
  authenticateBearerRequest,
  authenticateCronRequest,
  authenticateMutationSource,
  secureStringEqual,
} from './request-auth.js';

function requestWithAuthorization(value) {
  return new Request('https://example.test/api', {
    headers: value ? { authorization: value } : {},
  });
}

test('admin authentication fails closed in production when env is missing', () => {
  const result = authenticateAdminRequest(requestWithAuthorization(null), {
    env: {},
    nodeEnv: 'production',
  });
  assert.deepEqual(result, {
    ok: false,
    status: 503,
    code: 'admin_auth_not_configured',
  });
});

test('admin Basic credentials are checked', () => {
  const encoded = Buffer.from('admin:correct:with-colon').toString('base64');
  const result = authenticateAdminRequest(requestWithAuthorization(`Basic ${encoded}`), {
    env: {
      ADMIN_BASIC_AUTH_USERNAME: 'admin',
      ADMIN_BASIC_AUTH_PASSWORD: 'correct:with-colon',
    },
    nodeEnv: 'production',
  });
  assert.equal(result.ok, true);
  assert.equal(result.actorId, 'admin');
});

test('bearer and cron authentication reject missing server secrets', () => {
  assert.equal(authenticateBearerRequest(requestWithAuthorization('Bearer token'), '').status, 503);
  assert.equal(authenticateCronRequest(requestWithAuthorization('Bearer token'), {}).status, 503);
});

test('constant-time string helper compares exact values', () => {
  assert.equal(secureStringEqual('same', 'same'), true);
  assert.equal(secureStringEqual('same', 'different'), false);
});

test('unsafe admin requests require same-origin browser metadata or an explicit API header', () => {
  const sameOrigin = new Request('https://admin.example/api/posts', {
    method: 'POST',
    headers: { origin: 'https://admin.example', 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(authenticateMutationSource(sameOrigin).ok, true);

  const crossSite = new Request('https://admin.example/api/posts', {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(authenticateMutationSource(crossSite).code, 'cross_site_mutation_blocked');

  const apiClient = new Request('https://admin.example/api/posts', {
    method: 'POST',
    headers: { 'x-threads-admin-request': '1' },
  });
  assert.equal(authenticateMutationSource(apiClient).ok, true);
});
