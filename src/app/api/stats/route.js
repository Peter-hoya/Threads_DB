import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET() {
  try {
    const [totalPosts, pending, published, failed] = await Promise.all([
      prisma.post.count(),
      prisma.post.count({ where: { status: 'pending' } }),
      prisma.post.count({ where: { status: 'published' } }),
      prisma.post.count({ where: { status: 'failed' } }),
    ]);

    const accountStats = await prisma.account.findMany({
      include: {
        _count: { select: { posts: true, templates: true } },
        posts: {
          select: { status: true, platform: true },
        },
      },
    });

    const platformStats = await prisma.post.groupBy({
      by: ['platform'],
      _count: true,
    });

    const recentPosts = await prisma.post.findMany({
      take: 10,
      orderBy: { updatedAt: 'desc' },
      include: { account: { select: { accountName: true } } },
    });

    return NextResponse.json({
      counts: { total: totalPosts, pending, published, failed },
      accountStats: accountStats.map((a) => ({
        id: a.id,
        name: a.accountName,
        postCount: a._count.posts,
        templateCount: a._count.templates,
        byStatus: {
          pending: a.posts.filter((p) => p.status === 'pending').length,
          published: a.posts.filter((p) => p.status === 'published').length,
          failed: a.posts.filter((p) => p.status === 'failed').length,
        },
        byPlatform: {
          threads: a.posts.filter((p) => p.platform === 'threads').length,
          x: a.posts.filter((p) => p.platform === 'x').length,
        },
      })),
      platformStats: platformStats.map((p) => ({ platform: p.platform, count: p._count })),
      recentPosts: recentPosts.map((p) => ({
        id: p.id,
        content: p.content.substring(0, 60),
        status: p.status,
        platform: p.platform,
        account: p.account.accountName,
        updatedAt: p.updatedAt,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
