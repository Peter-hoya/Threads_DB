import { createHash, randomUUID } from 'node:crypto';

export const POST_STATUSES = Object.freeze([
  'draft',
  'queued',
  'publishing',
  'published',
  'failed',
  'cancelled',
]);

export const EDITABLE_POST_STATUSES = new Set([
  'draft',
  'queued',
  'failed',
  'cancelled',
]);

export function getContentReuseCooldownDays(env = process.env) {
  const value = Number(env.CONTENT_REUSE_COOLDOWN_DAYS || '90');
  if (!Number.isInteger(value) || value < 1 || value > 3650) {
    throw new Error('CONTENT_REUSE_COOLDOWN_DAYS는 1~3650 사이의 정수여야 합니다.');
  }
  return value;
}

const MEDIA_TYPES = new Set(['image', 'video']);
const DRAFT_FIELDS = new Set([
  'accountId',
  'platform',
  'content',
  'templateId',
  'mediaUrl',
  'mediaType',
  'replyContent',
  'affiliateDisclosure',
  'sourceUrl',
  'rightsConfirmed',
  'policyReviewConfirmed',
  'scheduledAt',
]);
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
];

function textLength(value) {
  return [...String(value || '')].length;
}

function finalPublishText(post) {
  const content = String(post.content || '').trim();
  const replyContent = cleanNullableString(post.replyContent);
  const disclosure = cleanNullableString(post.affiliateDisclosure);

  return {
    content: disclosure && !replyContent ? `${content}\n\n${disclosure}` : content,
    replyContent: replyContent
      ? (disclosure ? `${replyContent}\n\n${disclosure}` : replyContent)
      : null,
  };
}

function cleanNullableString(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim();
  return cleaned || null;
}

export function assertPublicHttpsUrl(value, fieldName = 'URL') {
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${fieldName} 형식이 올바르지 않습니다.`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`${fieldName}은 외부에서 접근 가능한 HTTPS 주소여야 합니다.`);
  }

  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
    throw new Error(`${fieldName}에 내부 네트워크 주소를 사용할 수 없습니다.`);
  }
  if (url.username || url.password) {
    throw new Error(`${fieldName}에 URL 자격증명을 포함할 수 없습니다.`);
  }

  return url.toString();
}

export function assertManagedPublishMediaUrl(value, env = process.env) {
  if (!value) return null;
  const projectUrl = env.SUPABASE_URL;
  if (!projectUrl) {
    throw new Error('미디어 승인 전에 Supabase Storage를 설정해야 합니다.');
  }

  let mediaUrl;
  let supabaseUrl;
  try {
    mediaUrl = new URL(value);
    supabaseUrl = new URL(projectUrl);
  } catch {
    throw new Error('Supabase 미디어 URL 설정이 올바르지 않습니다.');
  }
  const expectedPrefix = '/storage/v1/object/public/threads-publish/media/';
  if (
    mediaUrl.origin !== supabaseUrl.origin
    || !mediaUrl.pathname.startsWith(expectedPrefix)
    || mediaUrl.pathname.length <= expectedPrefix.length
    || mediaUrl.search
    || mediaUrl.hash
  ) {
    throw new Error('자동 발행 미디어는 검증된 threads-publish Supabase URL만 사용할 수 있습니다.');
  }
  return mediaUrl.toString();
}

export function validatePostDraft(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('게시물 요청은 JSON 객체여야 합니다.');
  }
  const unknownFields = Object.keys(input).filter((field) => !DRAFT_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`허용되지 않은 게시물 필드: ${unknownFields.join(', ')}`);
  }
  if (partial && Object.keys(input).length === 0) {
    throw new Error('수정할 게시물 필드가 필요합니다.');
  }

  const output = {};

  if (!partial || Object.hasOwn(input, 'accountId')) {
    const accountId = Number(input.accountId);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new Error('계정을 선택해주세요.');
    }
    output.accountId = accountId;
  }

  if (!partial || Object.hasOwn(input, 'platform')) {
    const platform = String(input.platform || '').toLowerCase();
    if (platform !== 'threads') {
      throw new Error('현재 공식 Threads API 발행만 지원합니다.');
    }
    output.platform = platform;
  }

  if (!partial || Object.hasOwn(input, 'content')) {
    const content = String(input.content || '').trim();
    if (!content) throw new Error('게시물 내용을 입력해주세요.');
    if (textLength(content) > 500) {
      throw new Error('Threads 게시물은 500자를 초과할 수 없습니다.');
    }
    output.content = content;
  }

  if (Object.hasOwn(input, 'templateId')) {
    if (!input.templateId) {
      output.templateId = null;
    } else {
      const templateId = Number(input.templateId);
      if (!Number.isSafeInteger(templateId) || templateId <= 0) {
        throw new Error('템플릿 ID가 올바르지 않습니다.');
      }
      output.templateId = templateId;
    }
  }

  if (Object.hasOwn(input, 'mediaUrl')) {
    output.mediaUrl = input.mediaUrl
      ? assertPublicHttpsUrl(String(input.mediaUrl).trim(), '미디어 URL')
      : null;
  }

  if (Object.hasOwn(input, 'mediaType')) {
    const mediaType = cleanNullableString(input.mediaType)?.toLowerCase() || null;
    if (mediaType && !MEDIA_TYPES.has(mediaType)) {
      throw new Error('미디어 형식은 image 또는 video만 사용할 수 있습니다.');
    }
    output.mediaType = mediaType;
  }

  if (Object.hasOwn(input, 'replyContent')) {
    const replyContent = cleanNullableString(input.replyContent);
    if (replyContent && textLength(replyContent) > 500) {
      throw new Error('첫 답글은 500자를 초과할 수 없습니다.');
    }
    output.replyContent = replyContent;
  }

  if (Object.hasOwn(input, 'affiliateDisclosure')) {
    const disclosure = cleanNullableString(input.affiliateDisclosure);
    if (disclosure && textLength(disclosure) > 500) {
      throw new Error('광고 고지 문구는 500자를 초과할 수 없습니다.');
    }
    output.affiliateDisclosure = disclosure;
  }

  if (Object.hasOwn(input, 'sourceUrl')) {
    output.sourceUrl = input.sourceUrl
      ? assertPublicHttpsUrl(String(input.sourceUrl).trim(), '출처 URL')
      : null;
  }

  if (Object.hasOwn(input, 'rightsConfirmed')) {
    output.rightsConfirmed = input.rightsConfirmed === true;
  }

  if (Object.hasOwn(input, 'policyReviewConfirmed')) {
    output.policyReviewConfirmed = input.policyReviewConfirmed === true;
  }

  if (Object.hasOwn(input, 'scheduledAt')) {
    if (!input.scheduledAt) {
      output.scheduledAt = null;
    } else {
      const scheduledAt = new Date(input.scheduledAt);
      if (Number.isNaN(scheduledAt.getTime())) {
        throw new Error('예약 시간이 올바르지 않습니다.');
      }
      output.scheduledAt = scheduledAt;
    }
  }

  if (!partial) {
    const effectiveMediaUrl = Object.hasOwn(output, 'mediaUrl') ? output.mediaUrl : input.mediaUrl;
    const effectiveMediaType = Object.hasOwn(output, 'mediaType') ? output.mediaType : input.mediaType;
    if (effectiveMediaUrl && !effectiveMediaType) {
      throw new Error('미디어가 있으면 이미지 또는 동영상 형식을 선택해야 합니다.');
    }
    if (!effectiveMediaUrl && effectiveMediaType) output.mediaType = null;
  }

  return output;
}

export function assertPostCanBeApproved(post, account) {
  if (!account) throw new Error('연결된 계정을 찾을 수 없습니다.');
  if (post.platform !== 'threads') throw new Error('현재 Threads 게시물만 승인할 수 있습니다.');
  if (account.role === 'primary') {
    throw new Error('본계정은 수동 운영 계정이므로 자동 발행할 수 없습니다.');
  }
  if (!account.isActive || !account.postingEnabled) {
    throw new Error('계정 자동 발행이 일시정지되어 있습니다.');
  }
  if (!account.credential) {
    throw new Error('Threads API 연결이 필요합니다. 계정 관리에서 OAuth 또는 토큰을 연결해주세요.');
  }
  if (!account.threadsUserId) {
    throw new Error('OAuth로 검증된 Threads 계정 ID가 필요합니다. 계정을 다시 연결해주세요.');
  }
  if (!['active', 'expiring'].includes(account.tokenStatus)) {
    throw new Error('Threads 토큰이 활성 상태가 아닙니다. OAuth로 다시 연결해주세요.');
  }
  if (account.tokenExpiresAt && new Date(account.tokenExpiresAt).getTime() <= Date.now() + 5 * 60 * 1000) {
    throw new Error('Threads 토큰이 만료됐거나 곧 만료됩니다. OAuth로 다시 연결해주세요.');
  }
  if (post.needsReconciliation) {
    throw new Error('외부 발행 결과 확인이 필요한 게시물입니다. 조정 완료 전 다시 승인할 수 없습니다.');
  }
  if (!post.rightsConfirmed) {
    throw new Error('본문과 미디어의 게시 권리를 확인해야 승인할 수 있습니다.');
  }
  if (!cleanNullableString(post.affiliateDisclosure)) {
    throw new Error('자동 발행 게시물에는 광고·제휴 고지 문구가 반드시 필요합니다.');
  }
  if (post.mediaUrl) assertManagedPublishMediaUrl(post.mediaUrl);
  if (!post.policyReviewConfirmed) {
    throw new Error('Meta 및 제휴 게시 정책 검토 확인이 필요합니다.');
  }

  const finalText = finalPublishText(post);
  if (textLength(finalText.content) > 500) {
    throw new Error('광고 고지를 포함한 최종 본문은 500자를 초과할 수 없습니다.');
  }
  if (finalText.replyContent && textLength(finalText.replyContent) > 500) {
    throw new Error('광고 고지를 포함한 최종 첫 답글은 500자를 초과할 수 없습니다.');
  }
}

function canonicalPublishPayload(post, { includeAccount = true } = {}) {
  const value = {
    platform: post.platform,
    content: String(post.content || '').trim().replace(/\r\n/g, '\n'),
    mediaUrl: post.mediaUrl || null,
    mediaType: post.mediaType || null,
    replyContent: cleanNullableString(post.replyContent),
    affiliateDisclosure: cleanNullableString(post.affiliateDisclosure),
  };
  return JSON.stringify(includeAccount
    ? { accountId: Number(post.accountId), ...value }
    : value);
}

export function buildPayloadHash(post) {
  return createHash('sha256')
    .update(canonicalPublishPayload(post, { includeAccount: true }))
    .digest('hex');
}

export function buildContentFingerprint(post) {
  return createHash('sha256')
    .update(canonicalPublishPayload(post, { includeAccount: false }))
    .digest('hex');
}

export function createIdempotencyKey(postId, payloadHash) {
  return `threads:${postId}:${payloadHash}:${randomUUID()}`;
}
