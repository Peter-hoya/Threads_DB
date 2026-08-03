import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { buildAuditEvent } from '@/lib/audit';
import { EDITABLE_POST_STATUSES, validatePostDraft } from '@/lib/post-policy';

const POLICY_FIELDS = new Set([
  'accountId',
  'platform',
  'content',
  'templateId',
  'mediaUrl',
  'mediaType',
  'replyContent',
  'affiliateDisclosure',
  'sourceUrl',
]);

function parseId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw routeError('게시물 ID가 올바르지 않습니다.', 400);
  return id;
}

function routeError(message, status = 400, code = 'INVALID_POST_REQUEST') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function equalValue(left, right) {
  if (left instanceof Date || right instanceof Date) {
    return new Date(left || 0).getTime() === new Date(right || 0).getTime();
  }
  return left === right;
}

async function lockPost(tx, id) {
  const rows = await tx.$queryRaw`SELECT "id" FROM "posts" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) throw routeError('게시물을 찾을 수 없습니다.', 404, 'POST_NOT_FOUND');
  return tx.post.findUniqueOrThrow({ where: { id } });
}

async function assertNoRunningJob(tx, postId) {
  const running = await tx.job.count({ where: { postId, status: 'running' } });
  if (running > 0) {
    throw routeError(
      'VPS worker가 이 게시물을 처리 중입니다. 결과가 확정된 뒤 다시 시도해주세요.',
      409,
      'POST_JOB_RUNNING',
    );
  }
}

async function assertRelations(tx, post) {
  const account = await tx.account.findUnique({ where: { id: post.accountId }, select: { id: true } });
  if (!account) throw routeError('계정을 찾을 수 없습니다.', 404, 'ACCOUNT_NOT_FOUND');
  if (post.templateId) {
    const templates = await tx.$queryRaw`
      SELECT "id"
      FROM "templates"
      WHERE "id" = ${post.templateId} AND "account_id" = ${post.accountId}
      FOR SHARE
    `;
    if (templates.length === 0) {
      throw routeError('선택한 템플릿은 발행 계정에 속하지 않습니다.', 400, 'TEMPLATE_ACCOUNT_MISMATCH');
    }
  }
}

export async function PATCH(request, { params }) {
  try {
    const { id: rawId } = await params;
    const id = parseId(rawId);
    const input = await request.json();
    const requested = validatePostDraft(input, { partial: true });

    const post = await prisma.$transaction(async (tx) => {
      const current = await lockPost(tx, id);
      if (current.needsReconciliation) {
        throw routeError(
          '외부 발행 결과 확인이 필요한 게시물은 조정 완료 전 수정할 수 없습니다.',
          409,
          'POST_NEEDS_RECONCILIATION',
        );
      }
      if (!EDITABLE_POST_STATUSES.has(current.status)) {
        throw routeError('발행 중이거나 발행 완료된 게시물은 수정할 수 없습니다.', 409, 'POST_NOT_EDITABLE');
      }

      const allowed = { ...requested };
      const merged = { ...current, ...allowed };
      validatePostDraft(merged);
      if (!merged.mediaUrl) {
        allowed.mediaType = null;
        merged.mediaType = null;
      }
      await assertRelations(tx, merged);

      const changedFields = Object.keys(allowed).filter((field) => !equalValue(current[field], allowed[field]));
      if (changedFields.length === 0) {
        throw routeError('실제로 변경된 게시물 필드가 없습니다.', 400, 'POST_NO_CHANGES');
      }
      const policyChanged = changedFields.some((field) => (
        POLICY_FIELDS.has(field) && !equalValue(current[field], allowed[field])
      ));
      if (policyChanged) {
        if (input.rightsConfirmed !== true) allowed.rightsConfirmed = false;
        if (input.policyReviewConfirmed !== true) allowed.policyReviewConfirmed = false;
      }

      // This update locks candidate jobs. If a worker leased one concurrently,
      // it commits as running first and the following count fails closed.
      await tx.job.updateMany({
        where: { postId: id, status: { in: ['queued', 'failed'] } },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
      await assertNoRunningJob(tx, id);

      const updated = await tx.post.update({
        where: { id },
        data: {
          ...allowed,
          status: 'draft',
          approvalStatus: 'draft',
          approvedAt: null,
          approvedBy: null,
          payloadHash: null,
          contentFingerprint: null,
          idempotencyKey: null,
          errorMessage: null,
          containerId: null,
          containerCreatedAt: null,
          postIdExternal: null,
          publishedAt: null,
          replyContainerId: null,
          replyPostIdExternal: null,
          replyPublishedAt: null,
        },
        include: {
          account: { select: { accountName: true, role: true, postingEnabled: true } },
          template: { select: { templateCode: true, templateName: true } },
        },
      });

      await tx.auditEvent.create({
        data: buildAuditEvent(request, {
          action: 'post.updated_approval_invalidated',
          entityType: 'post',
          entityId: id,
          accountId: updated.accountId,
          metadata: { changedFields, policyChanged },
        }),
      });
      return updated;
    });

    return NextResponse.json(post);
  } catch (error) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status || 400 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id: rawId } = await params;
    const id = parseId(rawId);

    const result = await prisma.$transaction(async (tx) => {
      const current = await lockPost(tx, id);
      if (current.needsReconciliation) {
        throw routeError(
          '외부 발행 결과 확인이 필요한 게시물은 삭제할 수 없습니다.',
          409,
          'POST_NEEDS_RECONCILIATION',
        );
      }
      if (current.status === 'publishing' || current.status === 'published') {
        throw routeError('발행 중이거나 발행 완료된 기록은 삭제할 수 없습니다.', 409, 'POST_NOT_DELETABLE');
      }

      await tx.job.updateMany({
        where: { postId: id, status: { in: ['queued', 'failed'] } },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
      await assertNoRunningJob(tx, id);

      if (current.status === 'queued') {
        await tx.post.update({
          where: { id },
          data: {
            status: 'cancelled',
            approvalStatus: 'draft',
            approvedAt: null,
            approvedBy: null,
          },
        });
        await tx.auditEvent.create({
          data: buildAuditEvent(request, {
            action: 'post.cancelled',
            entityType: 'post',
            entityId: id,
            accountId: current.accountId,
          }),
        });
        return { success: true, cancelled: true };
      }

      await tx.auditEvent.create({
        data: buildAuditEvent(request, {
          action: 'post.deleted',
          entityType: 'post',
          entityId: id,
          accountId: current.accountId,
        }),
      });
      await tx.post.delete({ where: { id } });
      return { success: true, deleted: true };
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status || 400 });
  }
}
