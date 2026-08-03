import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPostCanBeApproved,
  assertPublicHttpsUrl,
  buildContentFingerprint,
  buildPayloadHash,
  getContentReuseCooldownDays,
  assertManagedPublishMediaUrl,
  validatePostDraft,
} from './post-policy.js';

test('draft validation only accepts Threads and public HTTPS media', () => {
  assert.throws(
    () => validatePostDraft({ accountId: 1, platform: 'x', content: 'hello' }),
    /Threads/,
  );
  assert.throws(
    () => assertPublicHttpsUrl('http://127.0.0.1/file.jpg'),
    /HTTPS/,
  );
  assert.equal(
    assertPublicHttpsUrl('https://cdn.example.com/file.jpg'),
    'https://cdn.example.com/file.jpg',
  );
});

test('approved media must use the verified Supabase publish bucket path', () => {
  const env = { SUPABASE_URL: 'https://project.supabase.co' };
  assert.equal(
    assertManagedPublishMediaUrl(
      'https://project.supabase.co/storage/v1/object/public/threads-publish/media/2026/08/id.jpg',
      env,
    ),
    'https://project.supabase.co/storage/v1/object/public/threads-publish/media/2026/08/id.jpg',
  );
  assert.throws(() => assertManagedPublishMediaUrl('https://cdn.example.com/id.jpg', env), /threads-publish/);
  assert.throws(() => assertManagedPublishMediaUrl(
    'https://project.supabase.co/storage/v1/object/public/threads-publish/media/id.jpg?replace=1',
    env,
  ), /threads-publish/);
});

test('partial draft validation rejects unknown or empty writes and defers media pair checks to the merged post', () => {
  assert.throws(() => validatePostDraft({}, { partial: true }), /수정할/);
  assert.throws(() => validatePostDraft({ status: 'published' }, { partial: true }), /허용되지 않은/);
  assert.deepEqual(
    validatePostDraft({ mediaUrl: 'https://cdn.example.com/replacement.jpg' }, { partial: true }),
    { mediaUrl: 'https://cdn.example.com/replacement.jpg' },
  );
});

test('payload hash is stable for equivalent line endings', () => {
  const base = {
    accountId: 1,
    platform: 'threads',
    content: '첫 줄\n둘째 줄',
    mediaUrl: null,
    mediaType: null,
    replyContent: null,
    affiliateDisclosure: null,
  };
  assert.equal(buildPayloadHash(base), buildPayloadHash({ ...base, content: '첫 줄\r\n둘째 줄' }));
});

test('payload hash binds the account while fingerprint detects cross-account duplicates', () => {
  const base = {
    accountId: 1,
    platform: 'threads',
    content: '같은 원고',
    mediaUrl: null,
    mediaType: null,
    replyContent: null,
    affiliateDisclosure: null,
  };
  const otherAccount = { ...base, accountId: 2 };
  assert.notEqual(buildPayloadHash(base), buildPayloadHash(otherAccount));
  assert.equal(buildContentFingerprint(base), buildContentFingerprint(otherAccount));
});

test('approval blocks the manual primary account', () => {
  const post = { platform: 'threads', content: 'hello' };
  const account = {
    role: 'primary',
    isActive: true,
    postingEnabled: false,
    threadsUserId: 'threads-primary',
    tokenStatus: 'active',
    credential: {},
  };
  assert.throws(() => assertPostCanBeApproved(post, account), /본계정/);
});

test('every automation post requires disclosure and policy confirmation', () => {
  const account = {
    role: 'automation',
    isActive: true,
    postingEnabled: true,
    threadsUserId: 'threads-automation',
    tokenStatus: 'active',
    credential: {},
  };
  const post = {
    platform: 'threads',
    content: '추천 상품',
    replyContent: 'https://coupa.ng/example',
    rightsConfirmed: true,
    affiliateDisclosure: null,
    policyReviewConfirmed: false,
  };
  assert.throws(() => assertPostCanBeApproved(post, account), /고지/);
  assert.doesNotThrow(() => assertPostCanBeApproved({
    ...post,
    affiliateDisclosure: '쿠팡파트너스 활동으로 수수료를 제공받을 수 있습니다.',
    policyReviewConfirmed: true,
  }, account));
});

test('approval checks the final 500-character limit after disclosure is appended', () => {
  const account = {
    role: 'automation',
    isActive: true,
    postingEnabled: true,
    threadsUserId: 'threads-automation',
    tokenStatus: 'active',
    credential: {},
  };
  const base = {
    platform: 'threads',
    rightsConfirmed: true,
    policyReviewConfirmed: true,
    affiliateDisclosure: '광고'.repeat(10),
  };

  assert.throws(
    () => assertPostCanBeApproved({ ...base, content: '가'.repeat(490) }, account),
    /최종 본문/,
  );
  assert.throws(
    () => assertPostCanBeApproved({ ...base, content: '본문', replyContent: '가'.repeat(490) }, account),
    /최종 첫 답글/,
  );
});

test('approval rejects an unverified or expired Threads identity', () => {
  const post = {
    platform: 'threads',
    content: '일반 콘텐츠',
    rightsConfirmed: true,
    policyReviewConfirmed: true,
  };
  const account = {
    role: 'automation',
    isActive: true,
    postingEnabled: true,
    credential: {},
    tokenStatus: 'active',
  };
  assert.throws(() => assertPostCanBeApproved(post, account), /계정 ID/);
  assert.throws(() => assertPostCanBeApproved(post, {
    ...account,
    threadsUserId: 'verified-id',
    tokenExpiresAt: new Date(Date.now() - 1_000),
  }), /만료/);
});

test('content reuse cooldown has a bounded deployment setting', () => {
  assert.equal(getContentReuseCooldownDays({}), 90);
  assert.equal(getContentReuseCooldownDays({ CONTENT_REUSE_COOLDOWN_DAYS: '365' }), 365);
  assert.throws(
    () => getContentReuseCooldownDays({ CONTENT_REUSE_COOLDOWN_DAYS: '0' }),
    /1~3650/,
  );
});
