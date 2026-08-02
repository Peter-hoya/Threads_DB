import { NextResponse } from 'next/server';
import {
  IMAGE_MAX_BYTES,
  MediaValidationError,
  assertActualMedia,
  getMediaType,
  normalizeContentType,
} from '@/lib/media-validation';
import {
  PUBLISH_BUCKET,
  STAGING_BUCKET,
  SupabaseStorageError,
  copyToPublish,
  deleteStagingObjects,
  ensureMediaBuckets,
  getObjectInfo,
  isStorageNotFound,
  readPrivateObject,
  verifyCompletionToken,
  verifyPublicMedia,
} from '@/lib/supabase-storage';
import { apiErrorResponse } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function assertStoredObjectMatchesToken(info, payload) {
  if (!Number.isSafeInteger(info.size) || info.size !== payload.declaredSize) {
    throw new MediaValidationError(
      `업로드된 파일 크기(${info.size || 0})가 요청 크기(${payload.declaredSize})와 다릅니다.`,
      { code: 'UPLOADED_SIZE_MISMATCH', status: 422 },
    );
  }

  if (normalizeContentType(info.contentType) !== normalizeContentType(payload.contentType)) {
    throw new MediaValidationError(
      `업로드된 Content-Type(${info.contentType || '없음'})이 요청 형식(${payload.contentType})과 다릅니다.`,
      { code: 'UPLOADED_CONTENT_TYPE_MISMATCH', status: 422 },
    );
  }
}

async function readValidationBytes(payload) {
  if (getMediaType(payload.contentType) === 'image') {
    return readPrivateObject(STAGING_BUCKET, payload.stagingPath, {
      maxBytes: IMAGE_MAX_BYTES + 1,
    });
  }

  return readPrivateObject(STAGING_BUCKET, payload.stagingPath, {
    maxBytes: 64 * 1024,
    range: 'bytes=0-65535',
  });
}

async function completedResponse(payload, validation, { idempotent = false, stagingDeleted = true } = {}) {
  const verification = await verifyPublicMedia(payload.publishPath, {
    expectedContentType: payload.contentType,
    expectedSize: payload.declaredSize,
  });

  return NextResponse.json({
    success: true,
    idempotent,
    url: verification.url,
    path: payload.publishPath,
    bucket: PUBLISH_BUCKET,
    mediaType: getMediaType(payload.contentType),
    contentType: payload.contentType,
    size: payload.declaredSize,
    width: validation?.width,
    height: validation?.height,
    verified: verification.ok,
    stagingDeleted,
  });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const payload = verifyCompletionToken(body?.token);
    await ensureMediaBuckets();

    let stagingInfo;
    try {
      stagingInfo = await getObjectInfo(STAGING_BUCKET, payload.stagingPath);
    } catch (error) {
      if (!isStorageNotFound(error)) throw error;

      // 완료 응답 유실 후 재호출되는 경우 공개 객체를 검증하여 멱등 응답합니다.
      const publishedInfo = await getObjectInfo(PUBLISH_BUCKET, payload.publishPath);
      assertStoredObjectMatchesToken(publishedInfo, payload);
      return completedResponse(payload, null, { idempotent: true, stagingDeleted: true });
    }

    assertStoredObjectMatchesToken(stagingInfo, payload);
    const bytes = await readValidationBytes(payload);
    if (getMediaType(payload.contentType) === 'image' && bytes.byteLength !== stagingInfo.size) {
      throw new SupabaseStorageError('스토리지에서 이미지 전체를 읽지 못했습니다.', {
        status: 502,
        code: 'INCOMPLETE_IMAGE_DOWNLOAD',
      });
    }
    const validation = assertActualMedia({
      bytes,
      contentType: stagingInfo.contentType,
      size: stagingInfo.size,
    });

    try {
      await copyToPublish(payload.stagingPath, payload.publishPath);
    } catch (error) {
      // 이전 시도에서 복사는 성공했지만 응답이 끊긴 경우 동일 객체인지 검증하고 계속합니다.
      if (!(error instanceof SupabaseStorageError) || ![400, 409].includes(error.status)) throw error;
      const publishedInfo = await getObjectInfo(PUBLISH_BUCKET, payload.publishPath);
      assertStoredObjectMatchesToken(publishedInfo, payload);
    }

    const verification = await verifyPublicMedia(payload.publishPath, {
      expectedContentType: validation.contentType,
      expectedSize: validation.size,
    });

    let stagingDeleted = true;
    try {
      await deleteStagingObjects([payload.stagingPath]);
    } catch (error) {
      stagingDeleted = false;
      console.error('Promoted media staging cleanup failed:', error.message);
    }

    return NextResponse.json({
      success: true,
      idempotent: false,
      url: verification.url,
      path: payload.publishPath,
      bucket: PUBLISH_BUCKET,
      mediaType: validation.mediaType,
      contentType: validation.contentType,
      size: validation.size,
      width: validation.width,
      height: validation.height,
      verified: verification.ok,
      stagingDeleted,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({
        success: false,
        error: 'JSON 요청 본문이 올바르지 않습니다.',
        code: 'INVALID_JSON',
      }, { status: 400 });
    }
    return apiErrorResponse(error, '업로드 완료 검증에 실패했습니다.');
  }
}
