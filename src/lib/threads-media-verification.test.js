import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReconciledThreadsMedia } from './threads-media-verification.js';

test('reconciled main media must belong to the connected Threads user', () => {
  assert.deepEqual(validateReconciledThreadsMedia({
    id: 'media-1',
    owner: { id: 'user-1' },
    is_reply: false,
  }, {
    externalId: 'media-1',
    threadsUserId: 'user-1',
    target: 'main',
  }), {
    id: 'media-1',
    ownerId: 'user-1',
    isReply: false,
    repliedToId: null,
  });

  assert.throws(() => validateReconciledThreadsMedia({
    id: 'media-1', owner: { id: 'other-user' }, is_reply: false,
  }, {
    externalId: 'media-1', threadsUserId: 'user-1', target: 'main',
  }), /소유/);

  assert.throws(() => validateReconciledThreadsMedia({
    id: 'media-1', owner: { id: 'user-1' },
  }, {
    externalId: 'media-1', threadsUserId: 'user-1', target: 'main',
  }), /본문/);
});

test('reconciled reply must point to the exact published parent', () => {
  assert.doesNotThrow(() => validateReconciledThreadsMedia({
    id: 'reply-1',
    owner: 'user-1',
    is_reply: true,
    replied_to: { id: 'main-1' },
  }, {
    externalId: 'reply-1',
    threadsUserId: 'user-1',
    target: 'reply',
    parentPostId: 'main-1',
  }));

  assert.throws(() => validateReconciledThreadsMedia({
    id: 'reply-1', owner: 'user-1', is_reply: true, replied_to: 'other-main',
  }, {
    externalId: 'reply-1', threadsUserId: 'user-1', target: 'reply', parentPostId: 'main-1',
  }), /본문/);
});
