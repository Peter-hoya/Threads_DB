import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContentFingerprint, buildPayloadHash } from './post-policy.js';
import {
  hashContentFingerprint as buildWorkerContentFingerprint,
  hashPostPayload as buildWorkerPayloadHash,
} from '../../worker/src/payload.js';

test('admin and worker use the same immutable publish-payload contract', () => {
  const post = {
    accountId: 42,
    platform: 'threads',
    content: '첫 줄\r\n둘째 줄',
    mediaUrl: 'https://cdn.example.com/image.jpg',
    mediaType: 'image',
    replyContent: 'https://link.coupang.com/a/example',
    affiliateDisclosure: '제휴 활동으로 수수료를 받을 수 있습니다.',
  };

  assert.equal(buildPayloadHash(post), buildWorkerPayloadHash(post));
  assert.equal(buildContentFingerprint(post), buildWorkerContentFingerprint(post));
});
