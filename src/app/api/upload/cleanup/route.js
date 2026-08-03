import { NextResponse } from 'next/server';
import {
  deleteStagingObjects,
  ensureMediaBuckets,
  hasValidInternalApiToken,
  listStagingObjects,
} from '@/lib/supabase-storage';
import { apiErrorResponse } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeExplicitPaths(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 1000) {
    throw new TypeError('paths는 최대 1,000개의 staging 경로 배열이어야 합니다.');
  }
  const paths = [...new Set(value)];
  if (paths.some((path) => typeof path !== 'string' || !path.startsWith('incoming/'))) {
    throw new TypeError('paths에는 incoming/ 아래 경로만 입력할 수 있습니다.');
  }
  return paths;
}

export async function POST(request) {
  try {
    if (!hasValidInternalApiToken(request.headers)) {
      return NextResponse.json({
        success: false,
        error: 'cleanup 권한이 없습니다.',
        code: 'INVALID_INTERNAL_TOKEN',
      }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const explicitPaths = normalizeExplicitPaths(body.paths);
    const olderThanHours = body.olderThanHours === undefined ? 24 : Number(body.olderThanHours);
    if (!Number.isFinite(olderThanHours) || olderThanHours < 2 || olderThanHours > 24 * 30) {
      return NextResponse.json({
        success: false,
        error: 'olderThanHours는 2~720 사이여야 합니다.',
        code: 'INVALID_CLEANUP_AGE',
      }, { status: 400 });
    }

    await ensureMediaBuckets();
    const objects = await listStagingObjects({ limit: 1000 });
    const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000;
    const candidates = explicitPaths || objects
      .filter((object) => {
        const timestamp = Date.parse(object.createdAt || object.updatedAt || '');
        return Number.isFinite(timestamp) && timestamp <= cutoff;
      })
      .map((object) => object.path);

    const existingPaths = new Set(objects.map((object) => object.path));
    const paths = candidates.filter((path) => existingPaths.has(path));

    // 토큰 외에도 명시적 confirm=true가 있어야 실제 삭제합니다.
    if (body.confirm !== true) {
      return NextResponse.json({
        success: true,
        dryRun: true,
        olderThanHours,
        candidateCount: paths.length,
        paths,
        instruction: '동일 요청에 confirm:true를 추가해야 실제 삭제됩니다.',
      });
    }

    const deleted = paths.length ? await deleteStagingObjects(paths) : [];
    return NextResponse.json({
      success: true,
      dryRun: false,
      olderThanHours,
      deletedCount: paths.length,
      paths,
      storageResult: deleted,
    });
  } catch (error) {
    if (error instanceof TypeError) {
      return NextResponse.json({
        success: false,
        error: error.message,
        code: 'INVALID_CLEANUP_REQUEST',
      }, { status: 400 });
    }
    return apiErrorResponse(error, 'staging 미디어 정리에 실패했습니다.');
  }
}

export async function DELETE(request) {
  return POST(request);
}
