import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAccountCanPublish, nextOperatingTime } from '../src/account-policy.js';

function account(overrides = {}) {
  return {
    role: 'automation',
    isActive: true,
    postingEnabled: true,
    credential: {},
    threadsUserId: 'threads-user-1',
    tokenStatus: 'active',
    tokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
    timezone: 'Asia/Seoul',
    operatingStartMinute: 420,
    operatingEndMinute: 120,
    ...overrides,
  };
}

test('the default cross-midnight operating window excludes 02:00-07:00 KST', () => {
  assert.equal(nextOperatingTime(account(), new Date('2026-08-02T16:59:00Z')), null); // 01:59 KST
  assert.equal(
    nextOperatingTime(account(), new Date('2026-08-02T17:00:00Z')).toISOString(),
    '2026-08-02T22:00:00.000Z',
  );
  assert.equal(nextOperatingTime(account(), new Date('2026-08-02T22:00:00Z')), null); // 07:00 KST
});

test('disabled and manual accounts fail closed', () => {
  assert.throws(
    () => assertAccountCanPublish(account({ role: 'primary', postingEnabled: false })),
    (error) => error.code === 'PRIMARY_ACCOUNT_BLOCKED',
  );
  assert.throws(
    () => assertAccountCanPublish(account({ isActive: false })),
    (error) => error.code === 'ACCOUNT_POSTING_DISABLED',
  );
});
