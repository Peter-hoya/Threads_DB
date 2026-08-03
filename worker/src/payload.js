import { createHash } from 'node:crypto';
import { PermanentError } from './errors.js';

function cleanNullableString(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim();
  return cleaned || null;
}

function normalizedMediaType(post) {
  if (!post.mediaUrl) return 'TEXT';
  const type = String(post.mediaType || '').toUpperCase();
  if (type === 'IMAGE' || type === 'VIDEO') return type;
  throw new PermanentError('mediaType must be IMAGE or VIDEO when mediaUrl is present.', {
    code: 'INVALID_MEDIA_TYPE',
  });
}

export function canonicalPostPayload(post) {
  return {
    accountId: Number(post.accountId),
    platform: post.platform,
    content: String(post.content || '').trim().replace(/\r\n/g, '\n'),
    mediaUrl: post.mediaUrl || null,
    mediaType: post.mediaType || null,
    replyContent: cleanNullableString(post.replyContent),
    affiliateDisclosure: cleanNullableString(post.affiliateDisclosure),
  };
}

export function hashPostPayload(post) {
  return createHash('sha256').update(JSON.stringify(canonicalPostPayload(post))).digest('hex');
}

export function hashContentFingerprint(post) {
  const { accountId: _accountId, ...canonical } = canonicalPostPayload(post);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function assertApprovedPayload(post) {
  if (post.approvalStatus !== 'approved' || !post.approvedAt) {
    throw new PermanentError('Post is not approved.', { code: 'POST_NOT_APPROVED' });
  }
  if (!post.payloadHash) {
    throw new PermanentError('Approved post has no payload hash.', { code: 'PAYLOAD_HASH_MISSING' });
  }

  const actual = hashPostPayload(post);
  if (actual !== post.payloadHash) {
    throw new PermanentError('Post payload changed after approval.', {
      code: 'PAYLOAD_CHANGED_AFTER_APPROVAL',
      details: { expected: post.payloadHash, actual },
    });
  }
  const actualFingerprint = hashContentFingerprint(post);
  if (!post.contentFingerprint || actualFingerprint !== post.contentFingerprint) {
    throw new PermanentError('Post content fingerprint is missing or changed after approval.', {
      code: 'CONTENT_FINGERPRINT_INVALID',
      details: { expected: post.contentFingerprint, actual: actualFingerprint },
    });
  }
}

export function buildPublishText(post) {
  const disclosure = cleanNullableString(post.affiliateDisclosure);
  const reply = cleanNullableString(post.replyContent);
  const content = String(post.content || '').trim();

  return {
    content: disclosure && !reply ? `${content}\n\n${disclosure}` : content,
    replyContent: reply ? (disclosure ? `${reply}\n\n${disclosure}` : reply) : null,
  };
}

function assertThreadsLength(text, label) {
  if ([...String(text)].length > 500) {
    throw new PermanentError(`${label} exceeds the Threads 500-character limit after disclosure.`, {
      code: 'THREADS_TEXT_TOO_LONG',
    });
  }
}

export function buildContainerPayload(post, userId, token, { replyToId = null, reply = false } = {}) {
  const publishText = buildPublishText(post);
  const text = reply ? publishText.replyContent : publishText.content;
  if (!text || !String(text).trim()) {
    throw new PermanentError(reply ? 'Reply content is empty.' : 'Post content is empty.', {
      code: reply ? 'REPLY_EMPTY' : 'POST_EMPTY',
    });
  }
  assertThreadsLength(text, reply ? 'Reply' : 'Post');

  const payload = {
    endpointUserId: String(userId),
    media_type: reply ? 'TEXT' : normalizedMediaType(post),
    text: String(text),
    access_token: token,
  };

  if (!reply && payload.media_type === 'IMAGE') payload.image_url = String(post.mediaUrl);
  if (!reply && payload.media_type === 'VIDEO') payload.video_url = String(post.mediaUrl);
  if (replyToId) payload.reply_to_id = String(replyToId);

  return payload;
}
