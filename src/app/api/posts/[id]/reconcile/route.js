import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { buildAuditEvent } from '@/lib/audit';
import { getAccountAccessToken } from '@/lib/account-credentials';
import {
  findReconciliationJob,
  reconciliationKnownIdMatches,
  reconciliationTargetForJob,
} from '@/lib/reconciliation';
import { validateReconciledThreadsMedia } from '@/lib/threads-media-verification';

function requestError(message, status = 400, code = 'INVALID_RECONCILIATION') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function cleanExternalId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,255}$/.test(id)) {
    throw requestError('Meta에서 확인한 외부 게시물 ID가 필요합니다.');
  }
  return id;
}

async function verifyExternalMedia(post, externalId, target) {
  if (!post.account?.threadsUserId || !post.account?.credential) {
    throw requestError('Threads OAuth 계정을 다시 연결한 뒤 외부 ID를 확인해주세요.', 409, 'THREADS_RECONNECT_REQUIRED');
  }
  const accessToken = await getAccountAccessToken(post.account);
  const url = new URL(`https://graph.threads.net/v1.0/${encodeURIComponent(externalId)}`);
  url.searchParams.set('fields', 'id,owner,username,is_reply,replied_to');

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw requestError('Meta에서 외부 게시물 ID를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.', 502, 'THREADS_MEDIA_VERIFY_UNAVAILABLE');
  }
  const media = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw requestError('현재 OAuth 계정에서 해당 Meta 게시물을 조회할 수 없습니다.', 409, 'THREADS_MEDIA_NOT_VERIFIED');
  }
  try {
    return validateReconciledThreadsMedia(media, {
      externalId,
      threadsUserId: post.account.threadsUserId,
      target,
      parentPostId: post.postIdExternal,
    });
  } catch (error) {
    throw requestError(error.message, 409, 'THREADS_MEDIA_OWNERSHIP_MISMATCH');
  }
}

export async function POST(request, { params }) {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      throw requestError('조정 요청은 application/json 형식이어야 합니다.', 415, 'JSON_REQUIRED');
    }
    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) throw requestError('게시물 ID가 올바르지 않습니다.');

    const input = await request.json();
    const target = input.target;
    const outcome = input.outcome;
    if (!['main', 'reply'].includes(target) || !['published', 'not_published'].includes(outcome)) {
      throw requestError('target(main|reply)과 outcome(published|not_published)이 필요합니다.');
    }
    if (outcome === 'not_published' && input.confirmedNotPublished !== true) {
      throw requestError('Threads 앱에서 미발행을 직접 확인했다는 값이 필요합니다.');
    }
    if (outcome === 'published' && input.confirmedPublished !== true) {
      throw requestError('Threads 계정과 외부 게시물 ID를 직접 확인했다는 값이 필요합니다.');
    }
    const note = String(input.note || '').trim();
    if (!note || note.length > 1000) throw requestError('확인 근거를 1~1,000자로 기록해주세요.');
    const externalId = outcome === 'published' ? cleanExternalId(input.externalId) : null;

    const verificationSnapshot = outcome === 'published'
      ? await prisma.post.findUnique({
        where: { id },
        include: { account: { include: { credential: true } } },
      })
      : null;
    if (outcome === 'published' && !verificationSnapshot) {
      throw requestError('게시물을 찾을 수 없습니다.', 404, 'POST_NOT_FOUND');
    }
    if (outcome === 'published' && !verificationSnapshot.needsReconciliation) {
      throw requestError('이 게시물은 외부 결과 조정 대상이 아닙니다.', 409, 'RECONCILIATION_NOT_REQUIRED');
    }
    const verifiedMedia = outcome === 'published'
      ? await verifyExternalMedia(verificationSnapshot, externalId, target)
      : null;

    const post = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT "id" FROM "posts" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0) throw requestError('게시물을 찾을 수 없습니다.', 404, 'POST_NOT_FOUND');
      const current = await tx.post.findUniqueOrThrow({ where: { id } });
      if (!current.needsReconciliation) {
        throw requestError('이 게시물은 외부 결과 조정 대상이 아닙니다.', 409, 'RECONCILIATION_NOT_REQUIRED');
      }

      const reconciliationJobs = await tx.job.findMany({
        where: { postId: id, status: 'dead' },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 20,
        select: { id: true, type: true, result: true },
      });
      const reconciliationJob = findReconciliationJob(reconciliationJobs);
      if (!reconciliationJob) {
        throw requestError(
          '조정 대상 작업을 확인할 수 없습니다. 자동으로 상태를 변경하지 않습니다.',
          409,
          'RECONCILIATION_JOB_NOT_FOUND',
        );
      }
      const expectedTarget = reconciliationTargetForJob(reconciliationJob);
      if (!expectedTarget) {
        throw requestError('지원하지 않는 조정 작업 형식입니다.', 409, 'RECONCILIATION_JOB_INVALID');
      }
      if (target !== expectedTarget) {
        throw requestError(
          `이 결과는 ${expectedTarget === 'reply' ? '답글' : '본문'} 발행 건으로만 조정할 수 있습니다.`,
          409,
          'RECONCILIATION_TARGET_MISMATCH',
        );
      }
      if (!reconciliationKnownIdMatches(reconciliationJob, outcome, externalId)) {
        throw requestError(
          'Meta가 반환한 확정 게시물 ID와 동일한 값으로만 조정할 수 있습니다.',
          409,
          'RECONCILIATION_KNOWN_ID_MISMATCH',
        );
      }
      if (verifiedMedia && (
        current.accountId !== verificationSnapshot.accountId
        || verifiedMedia.ownerId !== String(verificationSnapshot.account.threadsUserId)
        || (expectedTarget === 'reply' && current.postIdExternal !== verificationSnapshot.postIdExternal)
      )) {
        throw requestError('조정 중 계정 상태가 변경되었습니다. 다시 확인해주세요.', 409, 'RECONCILIATION_ACCOUNT_CHANGED');
      }
      if (expectedTarget === 'reply' && !current.postIdExternal) {
        throw requestError('본문 외부 ID가 없어 답글 결과를 조정할 수 없습니다.', 409);
      }
      const running = await tx.job.count({ where: { postId: id, status: 'running' } });
      if (running > 0) throw requestError('worker 작업이 아직 실행 중입니다.', 409, 'POST_JOB_RUNNING');

      if (externalId) {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${externalId}, 0))`;
        const duplicateExternalId = await tx.post.findFirst({
          where: {
            id: { not: id },
            OR: [
              { postIdExternal: externalId },
              { replyPostIdExternal: externalId },
            ],
          },
          select: { id: true },
        });
        const conflictsWithCurrent = target === 'reply'
          ? current.postIdExternal === externalId
          : current.replyPostIdExternal === externalId;
        if (duplicateExternalId || conflictsWithCurrent) {
          throw requestError('이 Meta 게시물 ID는 이미 다른 발행 기록에 사용 중입니다.', 409, 'THREADS_MEDIA_ID_DUPLICATE');
        }
      }

      await tx.job.updateMany({
        where: { postId: id, status: { in: ['queued', 'failed'] } },
        data: { status: 'cancelled', finishedAt: new Date() },
      });

      const reconciliationNote = `${target}:${outcome} — ${note}`;
      const data = target === 'main'
        ? (outcome === 'published'
          ? {
            status: 'published',
            postIdExternal: externalId,
            publishedAt: current.publishedAt || new Date(),
            needsReconciliation: false,
            reconciliationNote,
            errorMessage: null,
          }
          : {
            status: 'failed',
            postIdExternal: null,
            publishedAt: null,
            containerId: null,
            containerCreatedAt: null,
            replyContainerId: null,
            replyPostIdExternal: null,
            replyPublishedAt: null,
            needsReconciliation: false,
            reconciliationNote,
            errorMessage: '운영자가 Threads에서 본문 미발행을 확인했습니다. 재승인할 수 있습니다.',
          })
        : (outcome === 'published'
          ? {
            status: 'published',
            replyPostIdExternal: externalId,
            replyPublishedAt: current.replyPublishedAt || new Date(),
            needsReconciliation: false,
            reconciliationNote,
            errorMessage: null,
          }
          : {
            replyPostIdExternal: null,
            replyPublishedAt: null,
            replyContainerId: null,
            needsReconciliation: false,
            reconciliationNote,
            errorMessage: '운영자가 Threads에서 답글 미발행을 확인했습니다. 답글을 다시 시도할 수 있습니다.',
          });

      const updated = await tx.post.update({ where: { id }, data });

      await tx.job.update({
        where: { id: reconciliationJob.id },
        data: {
          result: {
            ...(reconciliationJob.result && typeof reconciliationJob.result === 'object'
              ? reconciliationJob.result
              : {}),
            reconciliation: {
              target: expectedTarget,
              outcome,
              externalId,
              note,
              resolvedAt: new Date().toISOString(),
            },
          },
        },
      });

      if (target === 'main' && outcome === 'published' && current.replyContent && !current.replyPostIdExternal) {
        await tx.job.upsert({
          where: { dedupeKey: `${current.idempotencyKey}:reply` },
          update: {
            status: 'queued',
            runAt: new Date(),
            attempts: 0,
            lockedAt: null,
            lockedBy: null,
            lastError: null,
            finishedAt: null,
            payload: {
              payloadHash: current.payloadHash,
              contentFingerprint: current.contentFingerprint,
              idempotencyKey: current.idempotencyKey,
            },
          },
          create: {
            type: 'publish_reply',
            status: 'queued',
            postId: id,
            accountId: current.accountId,
            runAt: new Date(),
            dedupeKey: `${current.idempotencyKey}:reply`,
            payload: {
              payloadHash: current.payloadHash,
              contentFingerprint: current.contentFingerprint,
              idempotencyKey: current.idempotencyKey,
            },
          },
        });
      }

      await tx.auditEvent.create({
        data: buildAuditEvent(request, {
          action: 'post.external_result_reconciled',
          entityType: 'post',
          entityId: id,
          accountId: current.accountId,
          metadata: {
            target: expectedTarget,
            outcome,
            externalId,
            note,
            reconciliationJobId: reconciliationJob.id,
          },
        }),
      });
      return updated;
    });

    return NextResponse.json({ success: true, post });
  } catch (error) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status || 400 });
  }
}
