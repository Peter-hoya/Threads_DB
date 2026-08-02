import assert from 'node:assert/strict';
import test from 'node:test';
import { ReconciliationRequiredError, RetryableError } from '../src/errors.js';
import { PublishWorker } from '../src/worker.js';

function config() {
  return {
    workerId: 'worker-test',
    leaseTimeoutMs: 120_000,
    leaseHeartbeatMs: 60_000,
    retryBaseMs: 1_000,
    retryMaxMs: 60_000,
    alertOnRetry: false,
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

test('a transient API failure requeues the durable job with backoff', async () => {
  const job = {
    id: 1,
    type: 'publish_post',
    postId: 2,
    accountId: 3,
    attempts: 1,
    maxAttempts: 5,
    post: { id: 2, account: { id: 3 } },
  };
  let retried = null;
  const repository = {
    leaseNextJob: async () => job,
    heartbeatJob: async () => true,
    retryJob: async (...args) => { retried = args; },
  };
  const worker = new PublishWorker({
    repository,
    processor: { process: async () => { throw new RetryableError('rate limit', { retryAfterMs: 8_000 }); } },
    notifier: { notifyFailure: async () => {} },
    config: config(),
    logger: silentLogger,
  });

  assert.equal(await worker.runOne(), true);
  assert.equal(retried[0], job);
  assert.equal(retried[1], 'worker-test');
  assert.ok(retried[2].getTime() >= Date.now() + 7_500);
});

test('ambiguous publish is marked dead with reconciliation metadata and never retried', async () => {
  const job = {
    id: 1,
    type: 'publish_post',
    postId: 2,
    accountId: 3,
    attempts: 1,
    maxAttempts: 5,
    payload: {
      payloadHash: 'hash',
      contentFingerprint: 'fingerprint',
      idempotencyKey: 'key',
    },
    post: { id: 2, account: { id: 3 } },
  };
  let failed = null;
  let retried = false;
  const repository = {
    leaseNextJob: async () => job,
    heartbeatJob: async () => true,
    retryJob: async () => { retried = true; },
    failJob: async (...args) => { failed = args; },
  };
  const error = new ReconciliationRequiredError('ambiguous', {
    details: { knownExternalId: 'post-123' },
  });
  const worker = new PublishWorker({
    repository,
    processor: { process: async () => { throw error; } },
    notifier: { notifyFailure: async () => {} },
    config: config(),
    logger: silentLogger,
  });

  assert.equal(await worker.runOne(), true);
  assert.equal(retried, false);
  assert.equal(failed[3], true);
  assert.equal(failed[4].phase, 'needs_reconciliation');
  assert.equal(failed[4].details.knownExternalId, 'post-123');
});
