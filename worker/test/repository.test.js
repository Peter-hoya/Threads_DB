import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerRepository } from '../src/repository.js';

const generation = Object.freeze({
  payloadHash: 'payload-hash',
  contentFingerprint: 'content-fingerprint',
  idempotencyKey: 'threads:1:payload-hash:00000000-0000-4000-8000-000000000001',
});

test('duplicate query always blocks active copies and applies cooldown only to published copies', async () => {
  let query;
  const repository = new WorkerRepository({
    post: {
      findFirst: async (args) => {
        query = args;
        return null;
      },
    },
  });
  const before = Date.now();
  await repository.findDuplicateContent(11, 'fingerprint', 30);
  const after = Date.now();

  assert.deepEqual(query.where.id, { not: 11 });
  assert.equal(query.where.contentFingerprint, 'fingerprint');
  assert.deepEqual(query.where.OR[0], { status: { in: ['queued', 'publishing'] } });
  assert.equal(query.where.OR[1].status, 'published');
  const cutoff = query.where.OR[1].publishedAt.gte.getTime();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  assert.ok(cutoff >= before - thirtyDays && cutoff <= after - thirtyDays);
});

test('daily count interprets timestamp-without-time-zone as UTC before account timezone conversion', async () => {
  let sqlText = '';
  let sqlValues = [];
  const repository = new WorkerRepository({
    $queryRaw: async (strings, ...values) => {
      sqlText = strings.join('?');
      sqlValues = values;
      return [{ count: 2 }];
    },
  });

  assert.equal(await repository.getPublishedTodayCount(7, 'Asia/Seoul'), 2);
  assert.match(sqlText, /published_at" AT TIME ZONE 'UTC' AT TIME ZONE/);
  assert.match(sqlText, /NOW\(\) AT TIME ZONE/);
  assert.deepEqual(sqlValues, [7, 'Asia/Seoul', 'Asia/Seoul']);
});

test('main completion checks the exact generation and gives the reply job the same immutable payload', async () => {
  let postWhere;
  let replyUpsert;
  const post = {
    id: 1,
    accountId: 7,
    payloadHash: generation.payloadHash,
    contentFingerprint: generation.contentFingerprint,
    idempotencyKey: generation.idempotencyKey,
    replyPostIdExternal: null,
  };
  const tx = {
    job: {
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
      upsert: async (args) => { replyUpsert = args; },
    },
    post: {
      updateMany: async (args) => {
        postWhere = args.where;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => post,
    },
  };
  const repository = new WorkerRepository({ $transaction: async (fn) => fn(tx) });
  const job = {
    id: 4,
    postId: post.id,
    maxAttempts: 5,
    payload: generation,
    post: { publishedAt: null },
  };

  await repository.completeMain(job, 'worker-1', 'external-main', true, generation);
  assert.equal(postWhere.id, 1);
  assert.equal(postWhere.payloadHash, generation.payloadHash);
  assert.equal(postWhere.contentFingerprint, generation.contentFingerprint);
  assert.equal(postWhere.idempotencyKey, generation.idempotencyKey);
  assert.equal(postWhere.approvalStatus, 'approved');
  assert.equal(postWhere.needsReconciliation, false);
  assert.deepEqual(postWhere.status, { in: ['publishing', 'published'] });
  assert.deepEqual(replyUpsert.create.payload, generation);
  assert.equal(replyUpsert.create.type, 'publish_reply');
});

test('container persistence fails closed when the expected generation no longer matches', async () => {
  let capturedWhere;
  const tx = {
    job: { updateMany: async () => ({ count: 1 }) },
    post: {
      updateMany: async (args) => {
        capturedWhere = args.where;
        return { count: 0 };
      },
    },
  };
  const repository = new WorkerRepository({ $transaction: async (fn) => fn(tx) });

  await assert.rejects(
    repository.saveContainer(4, 'worker-1', 1, 'containerId', 'container-new', generation),
    (error) => error.code === 'POST_GENERATION_OR_CONTAINER_CONFLICT',
  );
  assert.equal(capturedWhere.payloadHash, generation.payloadHash);
  assert.equal(capturedWhere.idempotencyKey, generation.idempotencyKey);
  assert.deepEqual(capturedWhere.OR, [{ containerId: null }, { containerId: 'container-new' }]);
});

test('begin and reply completion transitions both carry the immutable generation predicate', async () => {
  const predicates = [];
  const tx = {
    job: {
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
    },
    post: {
      updateMany: async (args) => {
        predicates.push(args.where);
        return { count: 1 };
      },
    },
  };
  const repository = new WorkerRepository({ $transaction: async (fn) => fn(tx) });
  await repository.beginMainPublish(4, 'worker-1', 1, generation);
  await repository.completeReply(
    { id: 5, postId: 1, payload: generation, post: { replyPublishedAt: null } },
    'worker-1',
    'reply-external',
    generation,
  );

  for (const predicate of predicates) {
    assert.equal(predicate.payloadHash, generation.payloadHash);
    assert.equal(predicate.contentFingerprint, generation.contentFingerprint);
    assert.equal(predicate.idempotencyKey, generation.idempotencyKey);
    assert.equal(predicate.approvalStatus, 'approved');
    assert.equal(predicate.needsReconciliation, false);
  }
  assert.deepEqual(predicates[0].status, { in: ['queued', 'publishing', 'failed'] });
  assert.equal(predicates[1].status, 'published');
});

test('publish-start marker rechecks post generation and current account safety immediately before API', async () => {
  let postWhere;
  let jobResult;
  const tx = {
    job: {
      updateMany: async () => ({ count: 1 }),
      update: async (args) => { jobResult = args.data.result; },
    },
    post: {
      findFirst: async (args) => { postWhere = args.where; return { id: 1 }; },
    },
  };
  const repository = new WorkerRepository({ $transaction: async (fn) => fn(tx) });
  await repository.markPublishStarted(4, 'worker-1', 1, 'container-1', generation);

  assert.equal(postWhere.payloadHash, generation.payloadHash);
  assert.equal(postWhere.idempotencyKey, generation.idempotencyKey);
  assert.equal(postWhere.approvalStatus, 'approved');
  assert.equal(postWhere.needsReconciliation, false);
  assert.equal(postWhere.account.is.postingEnabled, true);
  assert.deepEqual(postWhere.account.is.tokenStatus, { in: ['active', 'expiring'] });
  assert.equal(jobResult.phase, 'threads_publish_started');
  assert.equal(jobResult.containerId, 'container-1');
});

test('terminal reconciliation marks both job result and post safety fields', async () => {
  let jobData;
  let postData;
  const tx = {
    job: {
      updateMany: async () => ({ count: 1 }),
      update: async (args) => { jobData = args.data; },
    },
    post: {
      updateMany: async (args) => { postData = args.data; return { count: 1 }; },
    },
  };
  const repository = new WorkerRepository({ $transaction: async (fn) => fn(tx) });
  const result = { phase: 'needs_reconciliation', details: { containerId: 'container-1' } };
  const job = { id: 4, postId: 1, type: 'publish_post', payload: generation };

  await repository.failJob(job, 'worker-1', 'ambiguous publish', true, result);
  assert.equal(jobData.status, 'dead');
  assert.deepEqual(jobData.result, result);
  assert.equal(postData.needsReconciliation, true);
  assert.match(postData.reconciliationNote, /Manual reconciliation required/);
});

test('a malformed job with no payload can still be finalized without mutating the post', async () => {
  let jobStatus;
  let postTouched = false;
  const tx = {
    job: {
      updateMany: async () => ({ count: 1 }),
      update: async (args) => { jobStatus = args.data.status; },
    },
    post: { updateMany: async () => { postTouched = true; } },
  };
  const repository = new WorkerRepository({ $transaction: async (fn) => fn(tx) });
  await repository.failJob({ id: 5, postId: 1, type: 'publish_post', payload: null }, 'worker-1', 'missing payload');
  assert.equal(jobStatus, 'failed');
  assert.equal(postTouched, false);
});
