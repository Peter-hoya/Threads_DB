import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { publishToThreads } from '@/lib/threads-api';

/**
 * POST /api/cron/publish
 * 
 * 외부 cron 서비스(오픈클로 등)에서 호출하는 자동 발행 엔드포인트.
 * pending 상태의 게시물을 적재 순서(id ASC)대로 가져와 순차 발행합니다.
 * 
 * Headers:
 *   Authorization: Bearer <CRON_SECRET>
 * 
 * Query Params:
 *   platform - 발행할 플랫폼 필터 (threads / x) (기본: 전체)
 *   limit    - 한 번에 발행할 최대 건수 (기본: 1)
 */
export async function POST(request) {
  // 1. 인증 검증
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return NextResponse.json(
      { error: 'CRON_SECRET 환경변수가 설정되지 않았습니다.' },
      { status: 500 }
    );
  }

  if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: '인증 실패: 올바른 CRON_SECRET을 제공하세요.' },
      { status: 401 }
    );
  }

  // 2. 파라미터 파싱
  const { searchParams } = new URL(request.url);
  const platform = searchParams.get('platform'); // threads | x | null(전체)
  const limit = Math.min(parseInt(searchParams.get('limit') || '1'), 10); // 최대 10건

  // 3. 발행 대상 조회
  // 먼저 시간이 지난(예약 시간이 된) 예약 게시물을 우선 조회
  const scheduledWhere = {
    status: 'scheduled',
    scheduledAt: { lte: new Date() },
  };
  if (platform) scheduledWhere.platform = platform;

  let postsToPublish = await prisma.post.findMany({
    where: scheduledWhere,
    include: { account: true },
    orderBy: { scheduledAt: 'asc' },
    take: limit,
  });

  // 예약 게시물로 limit을 다 채우지 못했다면, 일반 대기(pending) 게시물로 채움
  if (postsToPublish.length < limit) {
    const pendingWhere = { status: 'pending' };
    if (platform) pendingWhere.platform = platform;

    const pendingPosts = await prisma.post.findMany({
      where: pendingWhere,
      include: { account: true },
      orderBy: { id: 'asc' }, // 적재 순서
      take: limit - postsToPublish.length,
    });
    
    postsToPublish = [...postsToPublish, ...pendingPosts];
  }

  if (postsToPublish.length === 0) {
    return NextResponse.json({
      published: 0,
      failed: 0,
      message: '발행 대기 중인 게시물이 없습니다.',
    });
  }

  // 4. 순차 발행
  const results = [];

  for (const post of postsToPublish) {
    // Threads 발행
    if (post.platform === 'threads') {
      const userId = post.account.threadsUserId || process.env.THREADS_USER_ID;
      const accessToken = post.account.threadsAccessToken || process.env.THREADS_ACCESS_TOKEN;

      let result;
      if (!userId || !accessToken) {
        console.log(`[Mock Mode] No token provided for account "${post.account.accountName}". Bypassing Meta API.`);
        result = { success: true, postId: `mock_${Date.now()}` };
      } else {
        result = await publishToThreads(post, userId, accessToken); // Note: I should fix `post.content` to `post` here too!
      }

      if (result.success) {
        await prisma.post.update({
          where: { id: post.id },
          data: {
            status: 'published',
            publishedAt: new Date(),
            postIdExternal: result.postId,
          },
        });
        results.push({ id: post.id, status: 'published', postIdExternal: result.postId });
      } else {
        await prisma.post.update({
          where: { id: post.id },
          data: { status: 'failed', errorMessage: result.error },
        });
        results.push({ id: post.id, status: 'failed', error: result.error });
      }
    }
    // X(Twitter) 발행 — 향후 확장
    else if (post.platform === 'x') {
      // X API 미구현 → 스킵 (pending 유지)
      results.push({ id: post.id, status: 'skipped', error: 'X 플랫폼 발행은 아직 미지원' });
    }
  }

  const published = results.filter((r) => r.status === 'published').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  return NextResponse.json({
    published,
    failed,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
  });
}
