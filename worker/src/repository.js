import { PrismaClient } from '@prisma/client';
import { LostLeaseError, PermanentError } from './errors.js';

// A fixed namespace keeps our account-level advisory locks separate from other
// application locks while allowing every worker process to coordinate.
const ACCOUNT_LOCK_NAMESPACE = 1414678867;

function includeJobGraph() {
  return {
    post: { include: { account: { include: { credential: true } } } },
    account: { include: { credential: true } },
  };
}

function cleanError(message) {
  return String(message || 'Unknown worker error').slice(0, 4000);
}

function generationWhere(postId, expected) {
  if (!expected?.payloadHash || !expected?.contentFingerprint || !expected?.idempotencyKey) {
    throw new PermanentError('Immutable job approval payload is incomplete.', {
      code: 'JOB_PAYLOAD_MISSING',
    });
  }
  return {
    id: postId,
    payloadHash: expected.payloadHash,
    contentFingerprint: expected.contentFingerprint,
    idempotencyKey: expected.idempotencyKey,
  };
}

export class WorkerRepository {
  constructor(prisma = new PrismaClient()) {
    this.prisma = prisma;
  }

  async leaseNextJob(workerId, leaseTimeoutMs) {
    const leaseSeconds = Math.max(1, Math.ceil(leaseTimeoutMs / 1000));

    return this.prisma.$transaction(async (tx) => {
      // A worker can die during its final allowed attempt. Such a row cannot be
      // leased again without violating attempts <= max_attempts, so finalize it
      // explicitly instead of leaving it in running forever.
      const exhausted = await tx.$queryRaw`
        UPDATE "jobs"
        SET "status" = 'dead',
            "finished_at" = NOW(),
            "locked_at" = NULL,
            "locked_by" = NULL,
            "last_error" = COALESCE("last_error", 'Worker lease expired after the final attempt.'),
            "updated_at" = NOW()
        WHERE "status" = 'running'
          AND "attempts" >= "max_attempts"
          AND (
            "locked_at" IS NULL
            OR "locked_at" < NOW() - (${leaseSeconds} * INTERVAL '1 second')
          )
        RETURNING "post_id" AS "postId", "type", "result", "payload"
      `;
      for (const expired of exhausted) {
        if (
          !expired.postId
          || !expired.payload?.payloadHash
          || !expired.payload?.contentFingerprint
          || !expired.payload?.idempotencyKey
        ) continue;
        const main = expired.type === 'publish_post';
        const ambiguousPublish = expired.result?.phase === 'threads_publish_started';
        await tx.post.updateMany({
          where: {
            ...generationWhere(Number(expired.postId), expired.payload),
            ...(main ? { status: 'publishing' } : {}),
          },
          data: main
            ? {
              status: 'failed',
              errorMessage: 'Worker lease expired after the final attempt; reconcile Threads before retrying.',
              ...(ambiguousPublish
                ? {
                  needsReconciliation: true,
                  reconciliationNote: 'Worker lease expired after threads_publish started; verify the Threads account before retrying.',
                }
                : {}),
            }
            : {
              errorMessage: 'Reply worker lease expired after the final attempt.',
              ...(ambiguousPublish
                ? {
                  needsReconciliation: true,
                  reconciliationNote: 'Reply worker lease expired after threads_publish started; verify the Threads account before retrying.',
                }
                : {}),
            },
        });
      }

      const candidates = await tx.$queryRaw`
        SELECT j."id", p."account_id" AS "accountId"
        FROM "jobs" AS j
        INNER JOIN "posts" AS p ON p."id" = j."post_id"
        WHERE j."type" IN ('publish_post', 'publish_reply')
          AND j."run_at" <= NOW()
          AND j."attempts" < j."max_attempts"
          AND (
            j."status" = 'queued'
            OR (
              j."status" = 'running'
              AND (
                j."locked_at" IS NULL
                OR j."locked_at" < NOW() - (${leaseSeconds} * INTERVAL '1 second')
              )
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "jobs" AS active
            LEFT JOIN "posts" AS active_post ON active_post."id" = active."post_id"
            WHERE COALESCE(active."account_id", active_post."account_id") = p."account_id"
              AND active."id" <> j."id"
              AND active."status" = 'running'
              AND active."locked_at" >= NOW() - (${leaseSeconds} * INTERVAL '1 second')
          )
        ORDER BY j."run_at" ASC, j."id" ASC
        FOR UPDATE OF j SKIP LOCKED
        LIMIT 1
      `;

      const candidate = candidates[0];
      if (!candidate) return null;

      const accountId = Number(candidate.accountId);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${ACCOUNT_LOCK_NAMESPACE}, ${accountId})`;

      // The advisory lock serializes this second check for a given account. This
      // closes the race where two workers select different queued jobs before
      // either transaction has committed its running lease.
      const active = await tx.$queryRaw`
        SELECT active."id"
        FROM "jobs" AS active
        LEFT JOIN "posts" AS active_post ON active_post."id" = active."post_id"
        WHERE COALESCE(active."account_id", active_post."account_id") = ${accountId}
          AND active."id" <> ${Number(candidate.id)}
          AND active."status" = 'running'
          AND active."locked_at" >= NOW() - (${leaseSeconds} * INTERVAL '1 second')
        LIMIT 1
      `;
      if (active.length > 0) return null;

      await tx.$executeRaw`
        UPDATE "jobs"
        SET "status" = 'running',
            "locked_at" = NOW(),
            "locked_by" = ${workerId},
            "account_id" = ${accountId},
            "attempts" = "attempts" + 1,
            "last_error" = NULL,
            "updated_at" = NOW()
        WHERE "id" = ${Number(candidate.id)}
      `;

      return tx.job.findUnique({
        where: { id: Number(candidate.id) },
        include: includeJobGraph(),
      });
    });
  }

  async peekNextJob() {
    return this.prisma.job.findFirst({
      where: {
        type: { in: ['publish_post', 'publish_reply'] },
        status: 'queued',
        runAt: { lte: new Date() },
      },
      orderBy: [{ runAt: 'asc' }, { id: 'asc' }],
      include: includeJobGraph(),
    });
  }

  async heartbeatJob(jobId, workerId) {
    const result = await this.prisma.job.updateMany({
      where: { id: jobId, status: 'running', lockedBy: workerId },
      data: { lockedAt: new Date() },
    });
    return result.count === 1;
  }

  async #guard(tx, jobId, workerId) {
    const result = await tx.job.updateMany({
      where: { id: jobId, status: 'running', lockedBy: workerId },
      data: { lockedAt: new Date() },
    });
    if (result.count !== 1) throw new LostLeaseError();
  }

  async beginMainPublish(jobId, workerId, postId, expected) {
    return this.prisma.$transaction(async (tx) => {
      await this.#guard(tx, jobId, workerId);
      const result = await tx.post.updateMany({
        where: {
          ...generationWhere(postId, expected),
          approvalStatus: 'approved',
          needsReconciliation: false,
          status: { in: ['queued', 'publishing', 'failed'] },
        },
        data: {
          status: 'publishing',
          publishAttempts: { increment: 1 },
          lastAttemptAt: new Date(),
          errorMessage: null,
        },
      });
      if (result.count !== 1) {
        throw new PermanentError('Post is not in a publishable state.', {
          code: 'POST_STATE_NOT_PUBLISHABLE',
        });
      }
    });
  }

  async saveContainer(jobId, workerId, postId, field, containerId, expected) {
    if (!['containerId', 'replyContainerId'].includes(field)) {
      throw new TypeError('Unsupported container field.');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.#guard(tx, jobId, workerId);
      const result = await tx.post.updateMany({
        where: {
          ...generationWhere(postId, expected),
          approvalStatus: 'approved',
          needsReconciliation: false,
          status: { in: ['publishing', 'published'] },
          OR: [{ [field]: null }, { [field]: containerId }],
        },
        data: {
          [field]: containerId,
          ...(field === 'containerId' ? { containerCreatedAt: new Date() } : {}),
        },
      });
      if (result.count !== 1) {
        throw new PermanentError(
          `Post approval generation changed or a different ${field} is already persisted.`,
          { code: 'POST_GENERATION_OR_CONTAINER_CONFLICT' },
        );
      }
    });
  }

  async markPublishStarted(jobId, workerId, postId, containerId, expected) {
    return this.prisma.$transaction(async (tx) => {
      await this.#guard(tx, jobId, workerId);
      const post = await tx.post.findFirst({
        where: {
          ...generationWhere(postId, expected),
          approvalStatus: 'approved',
          needsReconciliation: false,
          status: { in: ['publishing', 'published'] },
          account: {
            is: {
              role: 'automation',
              isActive: true,
              postingEnabled: true,
              tokenStatus: { in: ['active', 'expiring'] },
              threadsUserId: { not: null },
              credential: { isNot: null },
              OR: [
                { tokenExpiresAt: null },
                { tokenExpiresAt: { gt: new Date() } },
              ],
            },
          },
        },
        select: { id: true },
      });
      if (!post) {
        throw new PermanentError('Post approval generation changed before threads_publish.', {
          code: 'POST_GENERATION_MISMATCH',
        });
      }
      await tx.job.update({
        where: { id: jobId },
        data: {
          result: {
            phase: 'threads_publish_started',
            containerId,
            startedAt: new Date().toISOString(),
          },
        },
      });
    });
  }

  async clearPublishStarted(jobId, workerId, postId, containerId, expected) {
    return this.prisma.$transaction(async (tx) => {
      await this.#guard(tx, jobId, workerId);
      const post = await tx.post.findFirst({
        where: generationWhere(postId, expected),
        select: { id: true },
      });
      if (!post) {
        throw new PermanentError('Post approval generation changed after a rejected publish request.', {
          code: 'POST_GENERATION_MISMATCH',
        });
      }
      await tx.job.update({
        where: { id: jobId },
        data: {
          result: {
            phase: 'threads_publish_rejected',
            containerId,
            clearedAt: new Date().toISOString(),
          },
        },
      });
    });
  }

  async completeMain(job, workerId, postIdExternal, hasReply, expected = job.payload) {
    return this.prisma.$transaction(async (tx) => {
      await this.#guard(tx, job.id, workerId);
      const now = new Date();
      const updated = await tx.post.updateMany({
        where: {
          ...generationWhere(job.postId, expected),
          approvalStatus: 'approved',
          needsReconciliation: false,
          status: { in: ['publishing', 'published'] },
        },
        data: {
          status: 'published',
          postIdExternal,
          publishedAt: job.post?.publishedAt || now,
          errorMessage: null,
          needsReconciliation: false,
          reconciliationNote: null,
        },
      });
      if (updated.count !== 1) {
        throw new PermanentError('Post approval generation changed before main completion.', {
          code: 'POST_GENERATION_MISMATCH',
        });
      }
      const post = await tx.post.findUniqueOrThrow({ where: { id: job.postId } });
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: 'succeeded',
          result: { postIdExternal },
          finishedAt: now,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });

      if (hasReply && !post.replyPostIdExternal) {
        await tx.job.upsert({
          where: { dedupeKey: `${post.idempotencyKey}:reply` },
          update: {
            payload: {
              payloadHash: post.payloadHash,
              contentFingerprint: post.contentFingerprint,
              idempotencyKey: post.idempotencyKey,
            },
          },
          create: {
            type: 'publish_reply',
            status: 'queued',
            postId: post.id,
            accountId: post.accountId,
            runAt: now,
            dedupeKey: `${post.idempotencyKey}:reply`,
            maxAttempts: job.maxAttempts,
            payload: {
              payloadHash: post.payloadHash,
              contentFingerprint: post.contentFingerprint,
              idempotencyKey: post.idempotencyKey,
            },
          },
        });
      }
    });
  }

  async completeReply(job, workerId, replyPostIdExternal, expected = job.payload) {
    return this.prisma.$transaction(async (tx) => {
      await this.#guard(tx, job.id, workerId);
      const now = new Date();
      const updated = await tx.post.updateMany({
        where: {
          ...generationWhere(job.postId, expected),
          approvalStatus: 'approved',
          needsReconciliation: false,
          status: 'published',
        },
        data: {
          replyPostIdExternal,
          replyPublishedAt: job.post?.replyPublishedAt || now,
          errorMessage: null,
          needsReconciliation: false,
          reconciliationNote: null,
        },
      });
      if (updated.count !== 1) {
        throw new PermanentError('Post approval generation changed before reply completion.', {
          code: 'POST_GENERATION_MISMATCH',
        });
      }
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: 'succeeded',
          result: { replyPostIdExternal },
          finishedAt: now,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
    });
  }

  async deferJob(job, workerId, runAt, reason) {
    return this.prisma.$transaction(async (tx) => {
      await this.#guard(tx, job.id, workerId);
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: 'queued',
          runAt,
          attempts: { decrement: 1 },
          lockedAt: null,
          lockedBy: null,
          lastError: cleanError(reason),
        },
      });
    });
  }

  async retryJob(job, workerId, runAt, errorMessage) {
    return this.prisma.$transaction(async (tx) => {
      await this.#guard(tx, job.id, workerId);
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: 'queued',
          runAt,
          lockedAt: null,
          lockedBy: null,
          lastError: cleanError(errorMessage),
        },
      });
      if (job.postId) {
        await tx.post.updateMany({
          where: generationWhere(job.postId, job.payload),
          data: job.type === 'publish_post'
            ? { status: 'queued', errorMessage: cleanError(errorMessage) }
            : { errorMessage: cleanError(`Reply retry: ${errorMessage}`) },
        });
      }
    });
  }

  async failJob(job, workerId, errorMessage, dead = false, result = null) {
    return this.prisma.$transaction(async (tx) => {
      await this.#guard(tx, job.id, workerId);
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: dead ? 'dead' : 'failed',
          finishedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: cleanError(errorMessage),
          ...(result ? { result } : {}),
        },
      });
      if (
        job.postId
        && job.payload?.payloadHash
        && job.payload?.contentFingerprint
        && job.payload?.idempotencyKey
      ) {
        const reconciliationRequired = result?.phase === 'needs_reconciliation';
        const knownExternalId = result?.details?.knownExternalId;
        const reconciliationContainerId = result?.details?.containerId;
        const reconciliationIdentifiers = [
          knownExternalId ? `known external ID=${knownExternalId}` : null,
          reconciliationContainerId ? `container ID=${reconciliationContainerId}` : null,
        ].filter(Boolean).join(', ');
        const reconciliationNote = reconciliationRequired
          ? cleanError(
            `Manual reconciliation required${reconciliationIdentifiers ? ` (${reconciliationIdentifiers})` : ''}: ${errorMessage}`,
          )
          : null;
        await tx.post.updateMany({
          where: generationWhere(job.postId, job.payload),
          data: job.type === 'publish_post'
            ? {
              status: 'failed',
              errorMessage: cleanError(errorMessage),
              ...(reconciliationRequired
                ? { needsReconciliation: true, reconciliationNote }
                : {}),
            }
            : {
              errorMessage: cleanError(`Reply failed: ${errorMessage}`),
              ...(reconciliationRequired
                ? { needsReconciliation: true, reconciliationNote }
                : {}),
            },
        });
      }
    });
  }

  async getPublishedTodayCount(accountId, timeZone) {
    const rows = await this.prisma.$queryRaw`
      SELECT COUNT(*)::integer AS "count"
      FROM "posts"
      WHERE "account_id" = ${accountId}
        AND "status" = 'published'
        AND "published_at" IS NOT NULL
        AND ("published_at" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone})::date
          = (NOW() AT TIME ZONE ${timeZone})::date
    `;
    return Number(rows[0]?.count || 0);
  }

  async findDuplicateContent(postId, contentFingerprint, cooldownDays = 90) {
    if (!contentFingerprint) return null;
    const safeCooldownDays = Math.max(0, Math.min(3650, Number(cooldownDays) || 0));
    const publishedCutoff = new Date(Date.now() - safeCooldownDays * 24 * 60 * 60 * 1000);
    const duplicateStates = [{ status: { in: ['queued', 'publishing'] } }];
    if (safeCooldownDays > 0) {
      duplicateStates.push({ status: 'published', publishedAt: { gte: publishedCutoff } });
    }
    return this.prisma.post.findFirst({
      where: {
        id: { not: postId },
        contentFingerprint,
        OR: duplicateStates,
      },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, accountId: true },
    });
  }

  async heartbeatWorker(workerId, metadata = {}) {
    const now = new Date();
    await this.prisma.workerHeartbeat.upsert({
      where: { workerId },
      update: { lastSeenAt: now, metadata },
      create: {
        workerId,
        version: '1.0.0',
        metadata,
        startedAt: now,
        lastSeenAt: now,
      },
    });
  }

  async disconnect() {
    await this.prisma.$disconnect();
  }
}
