import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { buildAuditEvent } from '@/lib/audit';
import {
  assertPostCanBeApproved,
  buildContentFingerprint,
  buildPayloadHash,
  createIdempotencyKey,
  getContentReuseCooldownDays,
} from '@/lib/post-policy';

function approvalError(message, status = 400, code = 'APPROVAL_REJECTED') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function requireJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw approvalError('승인 요청은 application/json 형식이어야 합니다.', 415, 'JSON_REQUIRED');
  }
}

async function lockApprovedCandidate(tx, id) {
  const rows = await tx.$queryRaw`SELECT "id" FROM "posts" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) throw approvalError('게시물을 찾을 수 없습니다.', 404, 'POST_NOT_FOUND');
  return tx.post.findUniqueOrThrow({
    where: { id },
    include: { account: { include: { credential: true } } },
  });
}

export async function POST(request, { params }) {
  try {
    requireJson(request);
    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw approvalError('게시물 ID가 올바르지 않습니다.', 400, 'INVALID_POST_ID');
    }

    const input = await request.json();
    const unknown = Object.keys(input || {}).filter((key) => key !== 'runAt');
    if (unknown.length) throw approvalError(`허용되지 않은 승인 필드: ${unknown.join(', ')}`);
    const requestedRunAt = input.runAt ? new Date(input.runAt) : null;
    if (requestedRunAt && Number.isNaN(requestedRunAt.getTime())) {
      throw approvalError('예약 시간이 올바르지 않습니다.');
    }

    const cooldownDays = getContentReuseCooldownDays();
    const actor = process.env.ADMIN_BASIC_AUTH_USERNAME || 'dashboard-admin';
    const result = await prisma.$transaction(async (tx) => {
      const post = await lockApprovedCandidate(tx, id);
      if (post.status === 'published') {
        throw approvalError('이미 발행된 게시물입니다.', 409, 'POST_ALREADY_PUBLISHED');
      }
      if (post.status === 'queued' || post.status === 'publishing') {
        throw approvalError('이미 발행 대기 중이거나 처리 중인 게시물입니다.', 409, 'POST_ALREADY_QUEUED');
      }

      assertPostCanBeApproved(post, post.account);
      const payloadHash = buildPayloadHash(post);
      const contentFingerprint = buildContentFingerprint(post);
      const publishedCutoff = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);
      const duplicate = await tx.post.findFirst({
        where: {
          id: { not: id },
          contentFingerprint,
          OR: [
            { status: { in: ['queued', 'publishing'] } },
            { status: 'published', publishedAt: { gte: publishedCutoff } },
          ],
        },
        select: { id: true, status: true, account: { select: { accountName: true } } },
      });
      if (duplicate) {
        throw approvalError(
          `동일 콘텐츠가 ${cooldownDays}일 재사용 제한 안에 있습니다. 게시물 #${duplicate.id} (${duplicate.account.accountName}, ${duplicate.status})`,
          409,
          'DUPLICATE_CONTENT_COOLDOWN',
        );
      }

      await tx.job.updateMany({
        where: { postId: id, status: { in: ['queued', 'failed'] } },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
      const running = await tx.job.count({ where: { postId: id, status: 'running' } });
      if (running > 0) {
        throw approvalError('이전 작업 결과가 아직 확정되지 않았습니다.', 409, 'POST_JOB_RUNNING');
      }

      const runAt = requestedRunAt || post.scheduledAt || new Date();
      const idempotencyKey = createIdempotencyKey(id, payloadHash);
      const approved = await tx.post.update({
        where: { id },
        data: {
          status: 'queued',
          approvalStatus: 'approved',
          approvedAt: new Date(),
          approvedBy: actor,
          scheduledAt: runAt,
          payloadHash,
          contentFingerprint,
          idempotencyKey,
          errorMessage: null,
          ...(post.status === 'failed' ? {
            containerId: null,
            containerCreatedAt: null,
            replyContainerId: null,
          } : {}),
        },
        include: { account: { select: { accountName: true, role: true } } },
      });

      const job = await tx.job.create({
        data: {
          type: 'publish_post',
          status: 'queued',
          runAt,
          dedupeKey: `publish:${id}:${idempotencyKey}`,
          postId: id,
          accountId: post.accountId,
          payload: { payloadHash, contentFingerprint, idempotencyKey },
        },
      });

      await tx.auditEvent.create({
        data: buildAuditEvent(request, {
          action: 'post.approved_and_queued',
          entityType: 'post',
          entityId: id,
          accountId: post.accountId,
          metadata: {
            payloadHash,
            contentFingerprint,
            idempotencyKey,
            runAt: runAt.toISOString(),
            cooldownDays,
          },
        }),
      });

      return { post: approved, jobId: job.id, queuedAt: runAt };
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const duplicateIndex = error.code === 'P2002';
    const status = duplicateIndex ? 409 : (error.status || 400);
    return NextResponse.json({
      error: duplicateIndex
        ? '동일 콘텐츠가 다른 계정에서 동시에 승인되었습니다.'
        : error.message,
      code: duplicateIndex ? 'DUPLICATE_ACTIVE_CONTENT' : error.code,
    }, { status });
  }
}
