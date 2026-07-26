import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

/**
 * GET /api/cron/status
 * 
 * 현재 발행 큐 상태를 조회합니다.
 * 오픈클로 모니터링 또는 대시보드에서 사용합니다.
 * 
 * Headers (선택):
 *   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request) {
  // 인증 (선택적 — 설정되어 있으면 검증)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        { error: '인증 실패: 올바른 CRON_SECRET을 제공하세요.' },
        { status: 401 }
      );
    }
  }

  try {
    // 플랫폼별 pending 게시물 수
    const pendingByPlatform = await prisma.post.groupBy({
      by: ['platform'],
      where: { status: 'pending' },
      _count: true,
    });

    // 전체 pending 수
    const totalPending = pendingByPlatform.reduce((sum, p) => sum + p._count, 0);

    // 다음 발행 대상 미리보기 (각 플랫폼별 1건씩)
    const nextThreads = await prisma.post.findFirst({
      where: { status: 'pending', platform: 'threads' },
      orderBy: { id: 'asc' },
      include: { account: { select: { accountName: true } } },
    });

    const nextX = await prisma.post.findFirst({
      where: { status: 'pending', platform: 'x' },
      orderBy: { id: 'asc' },
      include: { account: { select: { accountName: true } } },
    });

    // 최근 발행 결과 (최신 5건)
    const recentPublished = await prisma.post.findMany({
      where: { status: { in: ['published', 'failed'] } },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        platform: true,
        status: true,
        content: true,
        publishedAt: true,
        errorMessage: true,
        account: { select: { accountName: true } },
      },
    });

    return NextResponse.json({
      queue: {
        totalPending,
        byPlatform: pendingByPlatform.map((p) => ({
          platform: p.platform,
          count: p._count,
        })),
      },
      next: {
        threads: nextThreads
          ? {
              id: nextThreads.id,
              account: nextThreads.account.accountName,
              content: nextThreads.content.substring(0, 80),
              createdAt: nextThreads.createdAt,
            }
          : null,
        x: nextX
          ? {
              id: nextX.id,
              account: nextX.account.accountName,
              content: nextX.content.substring(0, 80),
              createdAt: nextX.createdAt,
            }
          : null,
      },
      recentResults: recentPublished.map((p) => ({
        id: p.id,
        platform: p.platform,
        status: p.status,
        account: p.account.accountName,
        content: p.content.substring(0, 60),
        publishedAt: p.publishedAt,
        error: p.errorMessage,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
