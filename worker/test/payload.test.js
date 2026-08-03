import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  assertApprovedPayload,
  buildContainerPayload,
  buildPublishText,
  hashContentFingerprint,
  hashPostPayload,
} from '../src/payload.js';

function basePost(overrides = {}) {
  const post = {
    id: 12,
    accountId: 3,
    platform: 'threads',
    content: '첫 줄\r\n둘째 줄',
    mediaUrl: null,
    mediaType: null,
    replyContent: '상품 링크',
    affiliateDisclosure: '제휴 활동으로 수수료를 받을 수 있습니다.',
    approvalStatus: 'approved',
    approvedAt: new Date(),
    ...overrides,
  };
  post.payloadHash = hashPostPayload(post);
  post.contentFingerprint = hashContentFingerprint(post);
  return post;
}

test('payload hash exactly follows the admin approval canonical form', () => {
  const post = basePost();
  const expectedCanonical = JSON.stringify({
    accountId: 3,
    platform: 'threads',
    content: '첫 줄\n둘째 줄',
    mediaUrl: null,
    mediaType: null,
    replyContent: '상품 링크',
    affiliateDisclosure: '제휴 활동으로 수수료를 받을 수 있습니다.',
  });
  assert.equal(
    post.payloadHash,
    createHash('sha256').update(expectedCanonical).digest('hex'),
  );
  assert.equal(post.payloadHash, 'c86f404849a889660ecfdf7d36013725701b69888bc20386658b9f9835e2d2af');
  assert.equal(post.contentFingerprint, 'db4f0afadbe9c4e82ba83908c3079db23d7a06ec7d4c93e9cc5250b7c762ed68');
  assert.doesNotThrow(() => assertApprovedPayload(post));
  assert.throws(() => assertApprovedPayload({ ...post, content: '변조' }), /changed after approval/);
});

test('affiliate disclosure is appended to the reply when one exists', () => {
  const post = basePost();
  const text = buildPublishText(post);
  assert.equal(text.content, '첫 줄\r\n둘째 줄');
  assert.equal(text.replyContent, '상품 링크\n\n제휴 활동으로 수수료를 받을 수 있습니다.');

  const payload = buildContainerPayload(post, 'user-1', 'token', {
    reply: true,
    replyToId: 'parent-1',
  });
  assert.equal(payload.text, text.replyContent);
  assert.equal(payload.reply_to_id, 'parent-1');
});

test('affiliate disclosure is appended to the body when there is no reply', () => {
  const post = basePost({ replyContent: null });
  post.payloadHash = hashPostPayload(post);
  post.contentFingerprint = hashContentFingerprint(post);
  const text = buildPublishText(post);
  assert.match(text.content, /둘째 줄\n\n제휴 활동/);
  assert.equal(text.replyContent, null);
});

test('final disclosure-appended text is checked against the 500-character limit', () => {
  const post = basePost({ content: '가'.repeat(490), replyContent: null, affiliateDisclosure: '광고'.repeat(10) });
  post.payloadHash = hashPostPayload(post);
  post.contentFingerprint = hashContentFingerprint(post);
  assert.throws(() => buildContainerPayload(post, 'user', 'token'), /500-character/);
});
