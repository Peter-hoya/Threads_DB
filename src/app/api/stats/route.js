import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET() {
  try {
    const [
      statusGroups,
      accountStats,
      platformStats,
      recentPosts,
      jobGroups,
      heartbeat,
      reconciliationCount,
    ] = await Promise.all([
      prisma.post.groupBy({ by: ['status'], _count: true }),
      prisma.account.findMany({
        include: {
          credential: { select: { accountId: true } },
          _count: { select: { posts: true, templates: true } },
          posts: { select: { status: true } },
        },
        orderBy: { id: 'asc' },
      }),
      prisma.post.groupBy({ by: ['platform'], _count: true }),
      prisma.post.findMany({
        take: 10,
        orderBy: { updatedAt: 'desc' },
        include: { account: { select: { accountName: true } } },
      }),
      prisma.job.groupBy({ by: ['status'], _count: true }),
      prisma.workerHeartbeat.findFirst({ orderBy: { lastSeenAt: 'desc' } }),
      prisma.post.count({ where: { needsReconciliation: true } }),
    ]);

    const byStatus = Object.fromEntries(statusGroups.map((item) => [item.status, item._count]));
    const jobs = Object.fromEntries(jobGroups.map((item) => [item.status, item._count]));

    return NextResponse.json({
      counts: {
        total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
        draft: byStatus.draft || 0,
        queued: byStatus.queued || 0,
        publishing: byStatus.publishing || 0,
        published: byStatus.published || 0,
        failed: byStatus.failed || 0,
        cancelled: byStatus.cancelled || 0,
        needsReconciliation: reconciliationCount,
      },
      jobs,
      heartbeat,
      configuration: {
        dashboardAuth: Boolean(process.env.ADMIN_BASIC_AUTH_USERNAME && process.env.ADMIN_BASIC_AUTH_PASSWORD),
        tokenEncryption: Boolean(process.env.THREADS_TOKEN_ENCRYPTION_KEY),
        metaOAuth: Boolean(process.env.THREADS_APP_ID && process.env.THREADS_APP_SECRET && process.env.THREADS_OAUTH_REDIRECT_URI),
        supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
        workerDatabase: true,
      },
      accountStats: accountStats.map((account) => ({
        id: account.id,
        name: account.accountName,
        role: account.role,
        active: account.isActive,
        postingEnabled: account.postingEnabled,
        connected: Boolean(account.credential),
        tokenExpiresAt: account.tokenExpiresAt || null,
        postCount: account._count.posts,
        templateCount: account._count.templates,
        byStatus: account.posts.reduce((result, post) => {
          result[post.status] = (result[post.status] || 0) + 1;
          return result;
        }, {}),
      })),
      platformStats: platformStats.map((item) => ({ platform: item.platform, count: item._count })),
      recentPosts: recentPosts.map((post) => ({
        id: post.id,
        content: post.content.substring(0, 60),
        status: post.status,
        platform: post.platform,
        account: post.account.accountName,
        updatedAt: post.updatedAt,
        error: post.errorMessage,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
