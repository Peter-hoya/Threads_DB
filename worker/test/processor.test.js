import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { hashContentFingerprint, hashPostPayload } from '../src/payload.js';
import { PublishProcessor } from '../src/processor.js';
import { RetryableError } from '../src/errors.js';

function credential(token, key, accountId) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`threads-account:${accountId}:v1`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    encryptedAccessToken: encrypted.toString('base64url'),
    accessTokenIv: iv.toString('base64url'),
    accessTokenAuthTag: cipher.getAuthTag().toString('base64url'),
    encryptionVersion: 1,
    tokenFingerprint: createHash('sha256').update(token).digest('hex').slice(0, 16),
  };
}

function fixture(overrides = {}) {
  const key = randomBytes(32);
  const account = {
    id: 7,
    accountName: '자동계정',
    role: 'automation',
    postingEnabled: true,
    isActive: true,
    tokenStatus: 'active',
    tokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
    threadsUserId: 'user-7',
    timezone: 'Asia/Seoul',
    operatingStartMinute: 0,
    operatingEndMinute: 0,
    dailyPostLimit: 6,
    credential: credential('access-token', key, 7),
    ...overrides.account,
  };
  const post = {
    id: 41,
    accountId: account.id,
    platform: 'threads',
    content: '추천 상품',
    mediaUrl: null,
    mediaType: null,
    replyContent: 'https://example.com/item',
    affiliateDisclosure: '제휴 활동으로 수수료를 받을 수 있습니다.',
    approvalStatus: 'approved',
    approvedAt: new Date(),
    rightsConfirmed: true,
    policyReviewConfirmed: true,
    status: 'queued',
    containerId: null,
    postIdExternal: null,
    replyContainerId: null,
    replyPostIdExternal: null,
    account,
    ...overrides.post,
  };
  post.payloadHash = hashPostPayload(post);
  post.contentFingerprint = hashContentFingerprint(post);
  post.idempotencyKey = `threads:${post.id}:${post.payloadHash}:c9f7390c-302b-4b73-932b-c8ecfc777d72`;
  const job = {
    id: 3,
    type: 'publish_post',
    status: 'running',
    postId: post.id,
    accountId: account.id,
    attempts: 1,
    maxAttempts: 5,
    payload: {
      payloadHash: post.payloadHash,
      contentFingerprint: post.contentFingerprint,
      idempotencyKey: post.idempotencyKey,
    },
    post,
    ...overrides.job,
  };
  return { key, account, post, job };
}

test('main publication persists the container and queues, rather than directly publishing, the reply', async () => {
  const { key, job } = fixture();
  const calls = [];
  const repository = {
    findDuplicateContent: async () => null,
    getPublishedTodayCount: async () => 0,
    beginMainPublish: async () => calls.push('begin'),
    saveContainer: async (_jobId, _workerId, _postId, field, id) => calls.push(`save:${field}:${id}`),
    markPublishStarted: async () => calls.push('publish-started'),
    completeMain: async (_job, _workerId, id, hasReply) => calls.push(`complete:${id}:${hasReply}`),
  };
  const threadsClient = {
    resolveUserId: async () => 'user-7',
    createContainer: async (payload) => {
      assert.equal(payload.text, '추천 상품');
      return 'container-7';
    },
    waitForContainer: async (_id, _token, { heartbeat }) => heartbeat(),
    publishContainer: async () => 'post-7',
  };
  const heartbeat = { assertOwned: async () => calls.push('heartbeat') };
  const processor = new PublishProcessor({
    repository,
    threadsClient,
    workerId: 'worker-1',
    env: { THREADS_TOKEN_ENCRYPTION_KEY: key.toString('base64') },
    now: () => new Date('2026-08-03T03:00:00Z'),
  });

  const result = await processor.process(job, heartbeat);
  assert.equal(result.postIdExternal, 'post-7');
  assert.deepEqual(calls.filter((call) => call.startsWith('save')), ['save:containerId:container-7']);
  assert.ok(calls.includes('complete:post-7:true'));
  assert.equal(calls.some((call) => call.includes('replyContainerId')), false);
});

test('an existing external post id is completed locally without another API call', async () => {
  const { job } = fixture({
    account: { isActive: false, postingEnabled: false },
    post: { postIdExternal: 'existing-post' },
  });
  let completed = null;
  const repository = {
    completeMain: async (...args) => { completed = args; },
  };
  const processor = new PublishProcessor({
    repository,
    threadsClient: new Proxy({}, { get: () => () => assert.fail('API must not be called') }),
    workerId: 'worker-1',
  });

  const result = await processor.process(job, { assertOwned: async () => {} });
  assert.equal(result.deduplicated, true);
  assert.equal(completed[2], 'existing-post');
});

test('primary/manual account is blocked even if a job was inserted directly', async () => {
  const { job } = fixture({ account: { role: 'primary', postingEnabled: false } });
  const processor = new PublishProcessor({ repository: {}, threadsClient: {}, workerId: 'worker-1' });
  await assert.rejects(
    processor.process(job, { assertOwned: async () => {} }),
    (error) => error.code === 'PRIMARY_ACCOUNT_BLOCKED' && error.retryable === false,
  );
});

test('worker rejects media outside the verified Supabase publish bucket', async () => {
  const { key, job } = fixture({
    post: { mediaUrl: 'https://cdn.example.com/replaceable.jpg', mediaType: 'image' },
  });
  const processor = new PublishProcessor({
    repository: new Proxy({}, { get: () => () => assert.fail('repository must not run') }),
    threadsClient: new Proxy({}, { get: () => () => assert.fail('Threads API must not run') }),
    workerId: 'worker-1',
    env: {
      THREADS_TOKEN_ENCRYPTION_KEY: key.toString('base64'),
      SUPABASE_URL: 'https://project.supabase.co',
    },
  });

  await assert.rejects(
    processor.process(job, { assertOwned: async () => {} }),
    (error) => error.code === 'MEDIA_ORIGIN_NOT_MANAGED' && error.retryable === false,
  );
});

test('duplicate content in another active post is blocked before any API call', async () => {
  const { job } = fixture();
  let receivedCooldown = null;
  const repository = {
    findDuplicateContent: async (_postId, _fingerprint, cooldownDays) => {
      receivedCooldown = cooldownDays;
      return { id: 9, status: 'published' };
    },
  };
  const processor = new PublishProcessor({
    repository,
    threadsClient: new Proxy({}, { get: () => () => assert.fail('API must not be called') }),
    workerId: 'worker-1',
    contentReuseCooldownDays: 45,
  });
  await assert.rejects(
    processor.process(job, { assertOwned: async () => {} }),
    (error) => error.code === 'DUPLICATE_CONTENT_BLOCKED',
  );
  assert.equal(receivedCooldown, 45);
});

test('job approval payload must match all immutable post generation fields', async () => {
  const { job } = fixture();
  job.payload = { ...job.payload, idempotencyKey: 'different-generation' };
  const processor = new PublishProcessor({ repository: {}, threadsClient: {}, workerId: 'worker-1' });
  await assert.rejects(
    processor.process(job, { assertOwned: async () => {} }),
    (error) => error.code === 'JOB_PAYLOAD_MISMATCH'
      && error.details.field === 'idempotencyKey',
  );
});

test('reply publication uses the disclosure-appended approved reply and parent id', async () => {
  const { key, job, post } = fixture({
    post: { postIdExternal: 'parent-post' },
    job: { type: 'publish_reply' },
  });
  job.post = post;
  const calls = [];
  const repository = {
    saveContainer: async (_jobId, _workerId, _postId, field) => calls.push(field),
    markPublishStarted: async () => calls.push('publish-started'),
    completeReply: async (_job, _workerId, id) => calls.push(`complete:${id}`),
  };
  const threadsClient = {
    resolveUserId: async () => 'user-7',
    createContainer: async (payload) => {
      assert.equal(payload.reply_to_id, 'parent-post');
      assert.match(payload.text, /example\.com\/item\n\n제휴 활동/);
      return 'reply-container';
    },
    waitForContainer: async () => {},
    publishContainer: async () => 'reply-post',
  };
  const processor = new PublishProcessor({
    repository,
    threadsClient,
    workerId: 'worker-1',
    env: { TOKEN_ENCRYPTION_KEY_V1: key.toString('base64') },
  });

  const result = await processor.process(job, { assertOwned: async () => {} });
  assert.equal(result.replyPostIdExternal, 'reply-post');
  assert.deepEqual(calls, ['replyContainerId', 'publish-started', 'complete:reply-post']);
});

function mainPublishMocks(job, publishContainer) {
  const events = [];
  const repository = {
    findDuplicateContent: async () => null,
    getPublishedTodayCount: async () => 0,
    beginMainPublish: async () => events.push('begin'),
    saveContainer: async () => events.push('container-saved'),
    markPublishStarted: async () => events.push('publish-started'),
    clearPublishStarted: async () => events.push('publish-marker-cleared'),
    completeMain: async () => events.push('completed'),
  };
  const threadsClient = {
    resolveUserId: async () => 'user-7',
    createContainer: async () => 'container-7',
    waitForContainer: async () => {},
    publishContainer,
  };
  const heartbeat = { assertOwned: async () => events.push('heartbeat') };
  return { repository, threadsClient, heartbeat, events, job };
}

test('network ambiguity after threads_publish starts becomes terminal reconciliation', async () => {
  const { key, job } = fixture();
  const mocks = mainPublishMocks(job, async () => {
    throw new RetryableError('network lost', { code: 'THREADS_NETWORK_ERROR' });
  });
  const processor = new PublishProcessor({
    ...mocks,
    repository: mocks.repository,
    threadsClient: mocks.threadsClient,
    workerId: 'worker-1',
    env: { THREADS_TOKEN_ENCRYPTION_KEY: key.toString('base64') },
  });

  await assert.rejects(
    processor.process(job, mocks.heartbeat),
    (error) => error.reconciliationRequired === true
      && error.code === 'PUBLISH_RECONCILIATION_REQUIRED',
  );
  assert.ok(mocks.events.includes('publish-started'));
  assert.equal(mocks.events.includes('publish-marker-cleared'), false);
  assert.equal(mocks.events.includes('completed'), false);
});

test('HTTP 429 after threads_publish starts is terminal because acceptance is not retried automatically', async () => {
  const { key, job } = fixture();
  const rateLimit = new RetryableError('rate limited', {
    code: 'THREADS_HTTP_429',
    retryAfterMs: 10_000,
    details: { status: 429 },
  });
  const mocks = mainPublishMocks(job, async () => { throw rateLimit; });
  const processor = new PublishProcessor({
    repository: mocks.repository,
    threadsClient: mocks.threadsClient,
    workerId: 'worker-1',
    env: { THREADS_TOKEN_ENCRYPTION_KEY: key.toString('base64') },
  });

  await assert.rejects(
    processor.process(job, mocks.heartbeat),
    (error) => error.reconciliationRequired === true,
  );
  assert.equal(mocks.events.includes('publish-marker-cleared'), false);
});

test('known external ID plus DB completion failure requires reconciliation, never republish', async () => {
  const { key, job } = fixture();
  const mocks = mainPublishMocks(job, async () => 'known-post-id');
  mocks.repository.completeMain = async () => { throw new Error('database unavailable'); };
  const processor = new PublishProcessor({
    repository: mocks.repository,
    threadsClient: mocks.threadsClient,
    workerId: 'worker-1',
    env: { THREADS_TOKEN_ENCRYPTION_KEY: key.toString('base64') },
  });

  await assert.rejects(
    processor.process(job, mocks.heartbeat),
    (error) => error.reconciliationRequired === true
      && error.details.knownExternalId === 'known-post-id',
  );
});

test('a reclaimed job with a durable publish-start marker never calls Threads again', async () => {
  const { job } = fixture({
    account: { isActive: false, postingEnabled: false },
    job: {
      result: {
        phase: 'threads_publish_started',
        containerId: 'container-previous',
        startedAt: '2026-08-03T00:00:00.000Z',
      },
    },
  });
  const processor = new PublishProcessor({
    repository: new Proxy({}, { get: () => () => assert.fail('repository publish methods must not run') }),
    threadsClient: new Proxy({}, { get: () => () => assert.fail('Threads API must not run') }),
    workerId: 'worker-1',
  });
  await assert.rejects(
    processor.process(job, { assertOwned: async () => {} }),
    (error) => error.reconciliationRequired === true
      && error.details.containerId === 'container-previous',
  );
});
