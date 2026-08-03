import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ALLOWED_MEDIA_TYPES,
  VIDEO_MAX_BYTES,
  assertUploadDeclaration,
  getExtensionForContentType,
  normalizeContentType,
} from './media-validation.js';

export const STAGING_BUCKET = 'threads-staging';
export const PUBLISH_BUCKET = 'threads-publish';
export const SIGNED_UPLOAD_TTL_SECONDS = 2 * 60 * 60;
export const COMPLETION_TOKEN_TTL_SECONDS = 26 * 60 * 60;
export const TUS_CHUNK_SIZE = 6 * 1024 * 1024;

const DEFAULT_BUCKET_FILE_SIZE_LIMIT = 50 * 1024 * 1024;
const BUCKET_CACHE_TTL_MS = 5 * 60 * 1000;
let bucketsReadyAt = 0;
let bucketsReadyPromise = null;

function bucketFileSizeLimit(env = process.env) {
  const raw = env.SUPABASE_BUCKET_FILE_SIZE_LIMIT_BYTES;
  if (!raw) return DEFAULT_BUCKET_FILE_SIZE_LIMIT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < IMAGE_MAX_BYTES || value > VIDEO_MAX_BYTES) {
    throw new SupabaseStorageError(
      'SUPABASE_BUCKET_FILE_SIZE_LIMIT_BYTES는 8MB~1GB 사이의 바이트 정수여야 합니다.',
      { status: 503, code: 'INVALID_BUCKET_FILE_SIZE_LIMIT' },
    );
  }
  return value;
}

function isBucketNotFoundError(error) {
  return error instanceof SupabaseStorageError
    && (error.status === 404 || /bucket not found/i.test(String(error.code || error.message)));
}

export class SupabaseStorageError extends Error {
  constructor(message, { status = 500, code = 'SUPABASE_STORAGE_ERROR', details = null } = {}) {
    super(message);
    this.name = 'SupabaseStorageError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function requireServerEnvironment() {
  const projectUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!projectUrl || !serviceRoleKey) {
    throw new SupabaseStorageError(
      'SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY 환경 변수가 필요합니다.',
      { status: 503, code: 'SUPABASE_NOT_CONFIGURED' },
    );
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(projectUrl);
  } catch {
    throw new SupabaseStorageError('SUPABASE_URL 형식이 올바르지 않습니다.', {
      status: 503,
      code: 'INVALID_SUPABASE_URL',
    });
  }

  const localDevelopmentHost = ['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && localDevelopmentHost)) {
    throw new SupabaseStorageError('SUPABASE_URL은 HTTPS URL이어야 합니다.', {
      status: 503,
      code: 'INVALID_SUPABASE_URL',
    });
  }

  parsedUrl.pathname = '';
  parsedUrl.search = '';
  parsedUrl.hash = '';
  const origin = parsedUrl.toString().replace(/\/$/, '');

  let directStorageOrigin = origin;
  if (/^[^.]+\.supabase\.(co|in|red)$/i.test(parsedUrl.hostname)) {
    parsedUrl.hostname = parsedUrl.hostname.replace(/\.supabase\./i, '.storage.supabase.');
    directStorageOrigin = parsedUrl.toString().replace(/\/$/, '');
  }

  return {
    origin,
    storageApiUrl: `${origin}/storage/v1`,
    directTusEndpoint: `${directStorageOrigin}/storage/v1/upload/resumable`,
    serviceRoleKey,
  };
}

function encodeObjectPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')) {
    throw new SupabaseStorageError('스토리지 경로가 올바르지 않습니다.', {
      status: 400,
      code: 'INVALID_STORAGE_PATH',
    });
  }

  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new SupabaseStorageError('스토리지 경로가 올바르지 않습니다.', {
      status: 400,
      code: 'INVALID_STORAGE_PATH',
    });
  }
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function serverHeaders(extraHeaders = {}) {
  const { serviceRoleKey } = requireServerEnvironment();
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    ...extraHeaders,
  };
}

async function parseStorageResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function storageErrorMessage(payload, fallback) {
  if (typeof payload === 'string') return payload || fallback;
  return payload?.message || payload?.error || payload?.error_description || fallback;
}

async function storageRequest(path, {
  method = 'GET',
  body,
  headers = {},
  raw = false,
  signal,
} = {}) {
  const { storageApiUrl } = requireServerEnvironment();
  const hasJsonBody = body !== undefined && body !== null
    && typeof body !== 'string'
    && !(body instanceof ArrayBuffer)
    && !ArrayBuffer.isView(body);

  const response = await fetch(`${storageApiUrl}${path}`, {
    method,
    headers: serverHeaders({
      ...(hasJsonBody ? { 'content-type': 'application/json' } : {}),
      ...headers,
    }),
    body: body === undefined || body === null
      ? undefined
      : (hasJsonBody ? JSON.stringify(body) : body),
    cache: 'no-store',
    signal,
  });

  if (raw && response.ok) return response;

  const payload = await parseStorageResponse(response);
  if (!response.ok) {
    throw new SupabaseStorageError(
      storageErrorMessage(payload, `Supabase Storage 요청 실패 (${response.status})`),
      {
        status: response.status,
        code: payload?.error || payload?.code || 'SUPABASE_STORAGE_REQUEST_FAILED',
        details: payload,
      },
    );
  }

  return payload;
}

function desiredBucketConfig(id) {
  return {
    id,
    name: id,
    public: id === PUBLISH_BUCKET,
    file_size_limit: bucketFileSizeLimit(),
    allowed_mime_types: [...ALLOWED_MEDIA_TYPES],
  };
}

function bucketNeedsUpdate(bucket, desired) {
  const currentAllowed = [...(bucket.allowed_mime_types || [])].sort();
  const desiredAllowed = [...desired.allowed_mime_types].sort();
  return Boolean(bucket.public) !== desired.public
    || Number(bucket.file_size_limit) !== desired.file_size_limit
    || JSON.stringify(currentAllowed) !== JSON.stringify(desiredAllowed);
}

export async function getMediaBucketStatus() {
  const statuses = [];
  for (const id of [STAGING_BUCKET, PUBLISH_BUCKET]) {
    try {
      const bucket = await storageRequest(`/bucket/${encodeURIComponent(id)}`);
      const desired = desiredBucketConfig(id);
      statuses.push({ id, exists: true, configured: !bucketNeedsUpdate(bucket, desired), bucket });
    } catch (error) {
      if (isBucketNotFoundError(error)) {
        statuses.push({ id, exists: false, configured: false, bucket: null });
      } else {
        throw error;
      }
    }
  }
  return statuses;
}

async function ensureBucket(id) {
  const desired = desiredBucketConfig(id);
  try {
    const bucket = await storageRequest(`/bucket/${encodeURIComponent(id)}`);
    if (bucketNeedsUpdate(bucket, desired)) {
      await storageRequest(`/bucket/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: desired,
      });
      return { id, action: 'updated' };
    }
    return { id, action: 'unchanged' };
  } catch (error) {
    if (!isBucketNotFoundError(error)) throw error;
    await storageRequest('/bucket', { method: 'POST', body: desired });
    return { id, action: 'created' };
  }
}

export async function ensureMediaBuckets({ force = false } = {}) {
  const now = Date.now();
  if (!force && bucketsReadyAt > now - BUCKET_CACHE_TTL_MS) {
    return { cached: true, buckets: [STAGING_BUCKET, PUBLISH_BUCKET] };
  }
  if (!force && bucketsReadyPromise) return bucketsReadyPromise;

  const setup = (async () => {
    const buckets = [];
    for (const id of [STAGING_BUCKET, PUBLISH_BUCKET]) {
      buckets.push(await ensureBucket(id));
    }
    bucketsReadyAt = Date.now();
    return { cached: false, buckets };
  })();

  bucketsReadyPromise = setup;
  try {
    return await setup;
  } finally {
    bucketsReadyPromise = null;
  }
}

function completionSecret() {
  const { serviceRoleKey } = requireServerEnvironment();
  return process.env.UPLOAD_SIGNING_SECRET || serviceRoleKey;
}

function signCompletionPayload(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', completionSecret())
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifyCompletionToken(token) {
  if (typeof token !== 'string' || token.length > 8192) {
    throw new SupabaseStorageError('완료 토큰이 올바르지 않습니다.', {
      status: 401,
      code: 'INVALID_COMPLETION_TOKEN',
    });
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new SupabaseStorageError('완료 토큰이 올바르지 않습니다.', {
      status: 401,
      code: 'INVALID_COMPLETION_TOKEN',
    });
  }

  const expected = createHmac('sha256', completionSecret()).update(parts[0]).digest();
  let received;
  try {
    received = Buffer.from(parts[1], 'base64url');
  } catch {
    received = Buffer.alloc(0);
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new SupabaseStorageError('완료 토큰 서명이 올바르지 않습니다.', {
      status: 401,
      code: 'INVALID_COMPLETION_TOKEN',
    });
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new SupabaseStorageError('완료 토큰 내용을 읽을 수 없습니다.', {
      status: 401,
      code: 'INVALID_COMPLETION_TOKEN',
    });
  }

  if (
    payload?.version !== 1
    || !payload.stagingPath
    || !payload.publishPath
    || !payload.contentType
    || !Number.isSafeInteger(payload.declaredSize)
    || !Number.isSafeInteger(payload.expiresAt)
  ) {
    throw new SupabaseStorageError('완료 토큰 내용이 올바르지 않습니다.', {
      status: 401,
      code: 'INVALID_COMPLETION_TOKEN',
    });
  }
  if (payload.expiresAt < Date.now()) {
    throw new SupabaseStorageError('완료 토큰이 만료되었습니다. 업로드를 다시 시작해주세요.', {
      status: 410,
      code: 'COMPLETION_TOKEN_EXPIRED',
    });
  }

  encodeObjectPath(payload.stagingPath);
  encodeObjectPath(payload.publishPath);
  if (!payload.stagingPath.startsWith('incoming/') || !payload.publishPath.startsWith('media/')) {
    throw new SupabaseStorageError('완료 토큰의 미디어 경로가 허용되지 않습니다.', {
      status: 401,
      code: 'INVALID_COMPLETION_TOKEN',
    });
  }

  return payload;
}

function buildPublicUrl(path) {
  const { storageApiUrl } = requireServerEnvironment();
  return `${storageApiUrl}/object/public/${encodeURIComponent(PUBLISH_BUCKET)}/${encodeObjectPath(path)}`;
}

export function getPublicMediaUrl(path) {
  return buildPublicUrl(path);
}

export async function createStagingUpload(input) {
  const declaration = assertUploadDeclaration(input, {
    maxVideoBytes: bucketFileSizeLimit(),
  });
  await ensureMediaBuckets();

  const objectId = randomUUID();
  const extension = getExtensionForContentType(declaration.contentType);
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const stagingPath = `incoming/${objectId}${extension}`;
  const publishPath = `media/${year}/${month}/${objectId}${extension}`;

  const signed = await storageRequest(
    `/object/upload/sign/${encodeURIComponent(STAGING_BUCKET)}/${encodeObjectPath(stagingPath)}`,
    {
      method: 'POST',
      body: {},
      headers: { 'x-upsert': 'false' },
    },
  );

  const { storageApiUrl, directTusEndpoint } = requireServerEnvironment();
  const signedUrl = new URL(`${storageApiUrl}${signed?.url || ''}`);
  const uploadToken = signedUrl.searchParams.get('token');
  if (!signed?.url || !uploadToken) {
    throw new SupabaseStorageError('Supabase가 signed upload token을 반환하지 않았습니다.', {
      status: 502,
      code: 'SIGNED_UPLOAD_TOKEN_MISSING',
    });
  }

  const issuedAt = Date.now();
  const uploadExpiresAt = issuedAt + SIGNED_UPLOAD_TTL_SECONDS * 1000;
  const completionExpiresAt = issuedAt + COMPLETION_TOKEN_TTL_SECONDS * 1000;
  const completionToken = signCompletionPayload({
    version: 1,
    stagingPath,
    publishPath,
    contentType: declaration.contentType,
    declaredSize: declaration.size,
    originalFilename: declaration.filename,
    issuedAt,
    expiresAt: completionExpiresAt,
  });

  const common = {
    protocol: declaration.uploadProtocol,
    bucket: STAGING_BUCKET,
    path: stagingPath,
    contentType: declaration.contentType,
    size: declaration.size,
    expiresAt: new Date(uploadExpiresAt).toISOString(),
  };

  if (declaration.uploadProtocol === 'standard') {
    return {
      upload: {
        ...common,
        standard: {
          url: signedUrl.toString(),
          method: 'PUT',
          headers: {
            'content-type': declaration.contentType,
            'cache-control': 'max-age=31536000',
            'x-upsert': 'false',
          },
        },
      },
      completion: {
        url: '/api/upload/complete',
        method: 'POST',
        body: { token: completionToken },
        expiresAt: new Date(completionExpiresAt).toISOString(),
      },
    };
  }

  return {
    upload: {
      ...common,
      tus: {
        endpoint: directTusEndpoint,
        headers: {
          'x-signature': uploadToken,
          'x-upsert': 'false',
        },
        chunkSize: TUS_CHUNK_SIZE,
        metadata: {
          bucketName: STAGING_BUCKET,
          objectName: stagingPath,
          contentType: declaration.contentType,
          cacheControl: '31536000',
        },
      },
    },
    completion: {
      url: '/api/upload/complete',
      method: 'POST',
      body: { token: completionToken },
      expiresAt: new Date(completionExpiresAt).toISOString(),
    },
  };
}

export async function getObjectInfo(bucket, path) {
  const data = await storageRequest(
    `/object/info/${encodeURIComponent(bucket)}/${encodeObjectPath(path)}`,
  );
  return {
    raw: data,
    size: Number(data?.size ?? data?.metadata?.size),
    contentType: normalizeContentType(
      data?.content_type || data?.metadata?.mimetype || data?.metadata?.contentType,
    ),
    createdAt: data?.created_at || data?.createdAt || null,
  };
}

export async function readPrivateObject(bucket, path, { maxBytes = null, range = null } = {}) {
  const response = await storageRequest(
    `/object/${encodeURIComponent(bucket)}/${encodeObjectPath(path)}`,
    {
      raw: true,
      headers: range ? { range } : {},
    },
  );

  if (!response.body) {
    throw new SupabaseStorageError('저장된 미디어 응답 본문이 없습니다.', {
      status: 502,
      code: 'EMPTY_STORAGE_RESPONSE',
    });
  }

  if (!maxBytes) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      const part = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(part);
      total += part.byteLength;
      if (part.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function copyToPublish(stagingPath, publishPath) {
  return storageRequest('/object/copy', {
    method: 'POST',
    body: {
      bucketId: STAGING_BUCKET,
      sourceKey: stagingPath,
      destinationKey: publishPath,
      destinationBucket: PUBLISH_BUCKET,
    },
  });
}

export async function deleteStagingObjects(paths) {
  const uniquePaths = [...new Set(paths)];
  if (!uniquePaths.length) return [];
  if (uniquePaths.length > 1000 || uniquePaths.some((path) => !path.startsWith('incoming/'))) {
    throw new SupabaseStorageError('삭제 가능한 staging 경로가 아닙니다.', {
      status: 400,
      code: 'INVALID_CLEANUP_PATH',
    });
  }
  uniquePaths.forEach(encodeObjectPath);
  return storageRequest(`/object/${encodeURIComponent(STAGING_BUCKET)}`, {
    method: 'DELETE',
    body: { prefixes: uniquePaths },
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function verifyPublicMedia(path, {
  expectedContentType = null,
  expectedSize = null,
  attempts = 3,
} = {}) {
  const url = buildPublicUrl(path);
  let lastFailure = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store', redirect: 'error' });
      const contentType = normalizeContentType(response.headers.get('content-type'));
      const rawLength = response.headers.get('content-length');
      const contentLength = rawLength === null ? null : Number(rawLength);

      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`;
      } else if (expectedContentType && contentType !== normalizeContentType(expectedContentType)) {
        lastFailure = `Content-Type 불일치 (${contentType || '없음'})`;
      } else if (
        expectedSize !== null
        && Number.isFinite(contentLength)
        && contentLength !== Number(expectedSize)
      ) {
        lastFailure = `Content-Length 불일치 (${contentLength})`;
      } else {
        return {
          ok: true,
          url,
          status: response.status,
          contentType,
          contentLength: Number.isFinite(contentLength) ? contentLength : null,
        };
      }
    } catch (error) {
      lastFailure = error.message;
    }

    if (attempt + 1 < attempts) await wait(150 * (2 ** attempt));
  }

  throw new SupabaseStorageError(`공개 미디어 URL HEAD 검증 실패: ${lastFailure || '알 수 없는 오류'}`, {
    status: 502,
    code: 'PUBLIC_MEDIA_VERIFICATION_FAILED',
  });
}

export async function listStagingObjects({ limit = 1000 } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 1000, 1), 1000);
  const allObjects = [];
  let offset = 0;

  while (allObjects.length < boundedLimit) {
    const pageLimit = Math.min(100, boundedLimit - allObjects.length);
    const page = await storageRequest(`/object/list/${encodeURIComponent(STAGING_BUCKET)}`, {
      method: 'POST',
      body: {
        prefix: 'incoming',
        limit: pageLimit,
        offset,
        sortBy: { column: 'created_at', order: 'asc' },
      },
    });
    if (!Array.isArray(page) || page.length === 0) break;

    for (const item of page) {
      if (!item?.name || item.id === null) continue;
      const path = item.name.startsWith('incoming/') ? item.name : `incoming/${item.name}`;
      allObjects.push({
        path,
        createdAt: item.created_at || item.createdAt || null,
        updatedAt: item.updated_at || item.updatedAt || null,
        size: Number(item.metadata?.size),
        contentType: normalizeContentType(item.metadata?.mimetype || item.metadata?.contentType),
      });
    }

    if (page.length < pageLimit) break;
    offset += page.length;
  }

  return allObjects;
}

export function hasValidInternalApiToken(headers) {
  // INTERNAL_API_SECRET가 canonical 이름이며, 기존 배포의 TOKEN 이름도 마이그레이션 동안 허용합니다.
  const expected = process.env.INTERNAL_API_SECRET || process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    throw new SupabaseStorageError('INTERNAL_API_SECRET 환경 변수가 설정되지 않았습니다.', {
      status: 503,
      code: 'INTERNAL_TOKEN_NOT_CONFIGURED',
    });
  }

  const authorization = headers.get('authorization') || '';
  const received = headers.get('x-internal-api-token')
    || (authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return receivedBuffer.length === expectedBuffer.length
    && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function isStorageNotFound(error) {
  return error instanceof SupabaseStorageError && error.status === 404;
}
