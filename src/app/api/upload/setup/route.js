import { NextResponse } from 'next/server';
import { ensureMediaBuckets, getMediaBucketStatus } from '@/lib/supabase-storage';
import { apiErrorResponse } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const buckets = await getMediaBucketStatus();
    return NextResponse.json({ success: true, buckets });
  } catch (error) {
    return apiErrorResponse(error, '스토리지 버킷 상태 확인에 실패했습니다.');
  }
}

export async function POST() {
  try {
    const setup = await ensureMediaBuckets({ force: true });
    const buckets = await getMediaBucketStatus();
    return NextResponse.json({ success: true, setup, buckets });
  } catch (error) {
    return apiErrorResponse(error, '스토리지 버킷 초기화에 실패했습니다.');
  }
}
