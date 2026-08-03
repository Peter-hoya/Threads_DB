import { NextResponse } from 'next/server';
import {
  PUBLISH_BUCKET,
  SupabaseStorageError,
  getPublicMediaUrl,
  verifyPublicMedia,
} from '@/lib/supabase-storage';
import { normalizeContentType } from '@/lib/media-validation';
import { apiErrorResponse } from '../../upload/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function pathFromPublicUrl(value) {
  const supplied = new URL(value);
  const markerUrl = new URL(getPublicMediaUrl('__marker__'));
  const pathPrefix = markerUrl.pathname.slice(0, -'__marker__'.length);

  if (
    supplied.protocol !== markerUrl.protocol
    || supplied.host !== markerUrl.host
    || !supplied.pathname.startsWith(pathPrefix)
    || supplied.search
    || supplied.hash
  ) {
    throw new SupabaseStorageError(
      `${PUBLISH_BUCKET} 버킷의 공개 원본 URL만 검증할 수 있습니다.`,
      { status: 400, code: 'UNSUPPORTED_PUBLIC_URL' },
    );
  }

  const encodedPath = supplied.pathname.slice(pathPrefix.length);
  const path = encodedPath.split('/').map((segment) => decodeURIComponent(segment)).join('/');
  if (!path.startsWith('media/')) {
    throw new SupabaseStorageError('공개 미디어 경로가 올바르지 않습니다.', {
      status: 400,
      code: 'INVALID_PUBLIC_MEDIA_PATH',
    });
  }
  return path;
}

export async function POST(request) {
  try {
    const body = await request.json();
    let path = body?.path;
    if (!path && body?.url) path = pathFromPublicUrl(body.url);
    if (typeof path !== 'string' || !path.startsWith('media/')) {
      return NextResponse.json({
        success: false,
        error: 'path 또는 threads-publish 공개 URL이 필요합니다.',
        code: 'MEDIA_PATH_REQUIRED',
      }, { status: 400 });
    }

    const verification = await verifyPublicMedia(path, {
      expectedContentType: body.contentType ? normalizeContentType(body.contentType) : null,
      expectedSize: Number.isSafeInteger(Number(body.size)) ? Number(body.size) : null,
    });

    return NextResponse.json({ success: true, ...verification, path });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof URIError) {
      return NextResponse.json({
        success: false,
        error: '검증 요청 형식이 올바르지 않습니다.',
        code: 'INVALID_VERIFY_REQUEST',
      }, { status: 400 });
    }
    return apiErrorResponse(error, '공개 미디어 URL 검증에 실패했습니다.');
  }
}
