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

    const where = {};
    if (status) where.status = status;
    if (accountId) where.accountId = parseInt(accountId);
    if (platform) where.platform = platform;

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where,
        include: {
          account: { select: { accountName: true } },
          template: { select: { templateCode: true, templateName: true } },
        },
        orderBy: { createdAt: 'desc' },
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
    const body = await request.json();
    const post = await prisma.post.create({
      data: {
        accountId: parseInt(body.accountId),
        platform: body.platform,
        content: body.content,
        templateId: body.templateId ? parseInt(body.templateId) : null,
        status: body.status || 'pending',
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
      },
    });
    return NextResponse.json(post, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
