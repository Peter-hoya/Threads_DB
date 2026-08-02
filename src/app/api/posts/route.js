import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { buildAuditEvent } from '@/lib/audit';
import { validatePostDraft } from '@/lib/post-policy';

const MAX_PAGE_SIZE = 100;

function asPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const accountId = searchParams.get('accountId');
    const platform = searchParams.get('platform');
    const page = asPositiveInt(searchParams.get('page'), 1);
    const limit = Math.min(asPositiveInt(searchParams.get('limit'), 20), MAX_PAGE_SIZE);
    const sort = searchParams.get('sort') === 'asc' ? 'asc' : 'desc';

    const where = {};
    if (status) where.status = status;
    if (accountId) where.accountId = asPositiveInt(accountId, 0);
    if (platform) where.platform = platform;

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where,
        include: {
          account: {
            select: {
              accountName: true,
              role: true,
              postingEnabled: true,
              isActive: true,
            },
          },
          template: { select: { templateCode: true, templateName: true } },
          jobs: {
            where: { status: { in: ['queued', 'running', 'failed', 'dead'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true, attempts: true, runAt: true, lastError: true },
          },
        },
        orderBy: sort === 'asc' ? { id: 'asc' } : { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.post.count({ where }),
    ]);

    return NextResponse.json({
      posts,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const input = await request.json();
    const data = validatePostDraft(input);

    const post = await prisma.$transaction(async (tx) => {
      const account = await tx.account.findUnique({
        where: { id: data.accountId },
        select: { id: true },
      });
      if (!account) {
        const error = new Error('계정을 찾을 수 없습니다.');
        error.status = 404;
        throw error;
      }
      if (data.templateId) {
        const templates = await tx.$queryRaw`
          SELECT "id"
          FROM "templates"
          WHERE "id" = ${data.templateId}
            AND "account_id" = ${data.accountId}
            AND "is_active" = true
          FOR SHARE
        `;
        if (templates.length === 0) {
          throw new Error('선택한 활성 템플릿은 발행 계정에 속하지 않습니다.');
        }
      }

      const created = await tx.post.create({
        data: {
          ...data,
          status: 'draft',
          approvalStatus: 'draft',
        },
        include: {
          account: { select: { accountName: true, role: true, postingEnabled: true } },
          template: { select: { templateCode: true, templateName: true } },
        },
      });
      await tx.auditEvent.create({
        data: buildAuditEvent(request, {
          action: 'post.created',
          entityType: 'post',
          entityId: created.id,
          accountId: created.accountId,
        }),
      });
      return created;
    });

    return NextResponse.json(post, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: error.status || 400 });
  }
}
