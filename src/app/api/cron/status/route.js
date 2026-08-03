import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { authenticateCronRequest, authErrorResponse } from '@/lib/request-auth';

export async function GET(request) {
  const auth = authenticateCronRequest(request);
  if (!auth.ok) return authErrorResponse(auth);

  try {
    const [jobGroups, postGroups, nextJobs, recentJobs, heartbeat, expiringAccounts] = await Promise.all([
      prisma.job.groupBy({ by: ['status'], _count: true }),
      prisma.post.groupBy({ by: ['status'], _count: true }),
      prisma.job.findMany({
        where: { status: 'queued' },
        orderBy: { runAt: 'asc' },
        take: 5,
        select: { id: true, type: true, postId: true, accountId: true, runAt: true, attempts: true },
      }),
      prisma.job.findMany({
        where: { status: { in: ['succeeded', 'failed', 'dead'] } },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: { id: true, type: true, status: true, postId: true, attempts: true, lastError: true, updatedAt: true },
      }),
      prisma.workerHeartbeat.findFirst({ orderBy: { lastSeenAt: 'desc' } }),
      prisma.account.findMany({
        where: {
          tokenExpiresAt: { lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
          credential: { isNot: null },
        },
        select: { id: true, accountName: true, tokenStatus: true, tokenExpiresAt: true },
      }),
    ]);

    return NextResponse.json({
      jobs: Object.fromEntries(jobGroups.map((item) => [item.status, item._count])),
      posts: Object.fromEntries(postGroups.map((item) => [item.status, item._count])),
      nextJobs,
      recentJobs,
      worker: heartbeat,
      expiringAccounts,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
