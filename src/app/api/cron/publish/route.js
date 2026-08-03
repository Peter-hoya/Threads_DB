import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { authenticateCronRequest, authErrorResponse } from '@/lib/request-auth';

/**
 * Compatibility endpoint for an existing OpenClaw/Hermes cron.
 * It never calls Meta directly. The durable VPS worker owns publishing; this
 * route only repairs an approved post whose queue job is unexpectedly missing.
 */
export async function POST(request) {
  const auth = authenticateCronRequest(request);
  if (!auth.ok) return authErrorResponse(auth);

  try {
    const { searchParams } = new URL(request.url);
    const requested = Number(searchParams.get('limit') || '10');
    const limit = Math.min(Math.max(Number.isInteger(requested) ? requested : 10, 1), 50);
    const now = new Date();

    const orphaned = await prisma.post.findMany({
      where: {
        platform: 'threads',
        status: 'queued',
        approvalStatus: 'approved',
        payloadHash: { not: null },
        contentFingerprint: { not: null },
        idempotencyKey: { not: null },
        OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
        account: {
          role: 'automation',
          isActive: true,
          postingEnabled: true,
          credential: { isNot: null },
        },
        jobs: {
          none: { status: { in: ['queued', 'running', 'succeeded'] } },
        },
      },
      select: {
        id: true,
        accountId: true,
        payloadHash: true,
        contentFingerprint: true,
        idempotencyKey: true,
        scheduledAt: true,
      },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });

    const repaired = [];
    for (const post of orphaned) {
      try {
        const job = await prisma.job.create({
          data: {
            type: 'publish_post',
            status: 'queued',
            postId: post.id,
            accountId: post.accountId,
            runAt: post.scheduledAt || now,
            dedupeKey: `repair:publish:${post.id}:${post.idempotencyKey}`,
            payload: {
              payloadHash: post.payloadHash,
              contentFingerprint: post.contentFingerprint,
              idempotencyKey: post.idempotencyKey,
              repairedByCron: true,
            },
          },
          select: { id: true, postId: true },
        });
        repaired.push(job);
      } catch (error) {
        if (error.code !== 'P2002') throw error;
      }
    }

    const heartbeat = await prisma.workerHeartbeat.findFirst({ orderBy: { lastSeenAt: 'desc' } });
    return NextResponse.json({
      mode: 'durable_vps_worker',
      directPublishingDisabled: true,
      repairedJobs: repaired,
      worker: heartbeat
        ? { id: heartbeat.workerId, lastSeenAt: heartbeat.lastSeenAt }
        : null,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
