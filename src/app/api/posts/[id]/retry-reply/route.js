import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { buildAuditEvent } from '@/lib/audit';
import { assertPostCanBeApproved, buildContentFingerprint, buildPayloadHash } from '@/lib/post-policy';

function retryError(message, status = 400, code = 'REPLY_RETRY_REJECTED') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export async function POST(request, { params }) {
  try {
    if (!(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
      throw retryError('답글 재시도는 application/json 형식이어야 합니다.', 415, 'JSON_REQUIRED');
    }
    await request.json();
    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) throw retryError('게시물 ID가 올바르지 않습니다.');

    const job = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT "id" FROM "posts" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0) throw retryError('게시물을 찾을 수 없습니다.', 404, 'POST_NOT_FOUND');
      const post = await tx.post.findUniqueOrThrow({
        where: { id },
        include: { account: { include: { credential: true } } },
      });
      if (post.needsReconciliation) throw retryError('먼저 외부 발행 결과를 조정해야 합니다.', 409);
      if (post.status !== 'published' || !post.postIdExternal) throw retryError('발행된 본문이 필요합니다.', 409);
      if (!post.replyContent || post.replyPostIdExternal) throw retryError('재시도할 미발행 답글이 없습니다.', 409);
      assertPostCanBeApproved(post, post.account);
      if (buildPayloadHash(post) !== post.payloadHash || buildContentFingerprint(post) !== post.contentFingerprint) {
        throw retryError('승인된 답글 payload가 변경되었습니다.', 409);
      }
      const active = await tx.job.count({
        where: { postId: id, type: 'publish_reply', status: { in: ['queued', 'running'] } },
      });
      if (active > 0) throw retryError('답글 작업이 이미 대기 또는 실행 중입니다.', 409);

      // A terminal or expired container must never be reused by an explicit
      // operator retry. Ambiguous threads_publish outcomes are blocked above by
      // needsReconciliation and must be reconciled first.
      await tx.post.update({
        where: { id },
        data: { replyContainerId: null, errorMessage: null },
      });

      const payload = {
        payloadHash: post.payloadHash,
        contentFingerprint: post.contentFingerprint,
        idempotencyKey: post.idempotencyKey,
      };
      const retryJob = await tx.job.upsert({
        where: { dedupeKey: `${post.idempotencyKey}:reply` },
        update: {
          status: 'queued',
          runAt: new Date(),
          attempts: 0,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          result: null,
          finishedAt: null,
          payload,
        },
        create: {
          type: 'publish_reply',
          status: 'queued',
          postId: id,
          accountId: post.accountId,
          runAt: new Date(),
          dedupeKey: `${post.idempotencyKey}:reply`,
          payload,
        },
      });
      await tx.auditEvent.create({
        data: buildAuditEvent(request, {
          action: 'post.reply_retry_queued',
          entityType: 'post',
          entityId: id,
          accountId: post.accountId,
          metadata: { jobId: retryJob.id },
        }),
      });
      return retryJob;
    });
    return NextResponse.json({ success: true, jobId: job.id });
  } catch (error) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status || 400 });
  }
}
