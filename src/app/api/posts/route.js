import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const accountId = searchParams.get('accountId');
    const platform = searchParams.get('platform');
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '20');
    const sort = searchParams.get('sort') || 'desc'; // asc: 적재순서, desc: 최신순

    const where = {};
    if (status) where.status = status;
    if (accountId) where.accountId = parseInt(accountId);
    if (platform) where.platform = platform;

    const orderBy = sort === 'asc' ? { id: 'asc' } : { createdAt: 'desc' };

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where,
        include: {
          account: { select: { accountName: true } },
          template: { select: { templateCode: true, templateName: true } },
        },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.post.count({ where }),
    ]);

    return NextResponse.json({ posts, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { accountId, platform, content, templateId, mediaUrl, mediaType, replyContent, scheduledAt } = await request.json();
    if (!accountId || !platform || !content) {
      return NextResponse.json({ error: '필수 필드가 누락되었습니다.' }, { status: 400 });
    }

    let parsedScheduledAt = null;
    let initialStatus = 'pending';
    
    if (scheduledAt) {
      parsedScheduledAt = new Date(scheduledAt);
      initialStatus = 'scheduled';
    }

    const newPost = await prisma.post.create({
      data: {
        accountId: parseInt(accountId),
        platform,
        content,
        templateId: templateId ? parseInt(templateId) : null,
        mediaUrl: mediaUrl || null,
        mediaType: mediaUrl ? (mediaType || 'image') : null,
        replyContent: replyContent || null,
        scheduledAt: parsedScheduledAt,
        status: initialStatus,
      },
      include: { account: true, template: true },
    });
    return NextResponse.json(newPost);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
