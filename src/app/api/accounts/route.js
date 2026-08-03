import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import {
  credentialPresenceSelect,
  parseAccountWriteBody,
  sanitizeAccount,
  upsertAccountCredential,
  verifyManualThreadsToken,
} from '@/lib/account-credentials';
import { parseBasicAuthorization } from '@/lib/request-auth';

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function actorId(request) {
  return parseBasicAuthorization(request)?.username ?? 'admin';
}

function apiError(error) {
  if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid JSON request body.' }, { status: 400 });
  if (error?.status) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error?.code === 'P2002') return NextResponse.json({ error: 'An account with this name already exists.' }, { status: 409 });
  console.error('Account API error:', error?.message ?? error);
  return NextResponse.json({ error: 'Unable to process the account request.' }, { status: 500 });
}

export async function GET() {
  try {
    const accounts = await prisma.account.findMany({
      include: {
        credential: { select: credentialPresenceSelect },
        _count: { select: { posts: true, templates: true } },
      },
      orderBy: { id: 'asc' },
    });
    return NextResponse.json(accounts.map(sanitizeAccount), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request) {
  try {
    const parsed = parseAccountWriteBody(await request.json());
    const verifiedProfile = parsed.accessToken
      ? await verifyManualThreadsToken(parsed.accessToken)
      : null;

    if (parsed.data.postingEnabled && !parsed.accessToken) {
      throw validationError('Connect a Threads token before enabling automatic posting.');
    }
    if (verifiedProfile) {
      const duplicateProfile = await prisma.account.findFirst({
        where: { threadsUserId: verifiedProfile.id },
        select: { id: true },
      });
      if (duplicateProfile) {
        const error = validationError('This Threads profile is already connected to another account.');
        error.status = 409;
        throw error;
      }
    }

    const accountId = await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: {
          ...parsed.data,
          ...(verifiedProfile ? {
            threadsUserId: verifiedProfile.id,
            threadsUsername: verifiedProfile.username,
          } : {}),
          postingEnabled: parsed.data.role === 'primary' ? false : (parsed.data.postingEnabled ?? false),
          ...(parsed.accessToken ? {
            tokenStatus: 'active',
            tokenType: 'manual_bearer',
            tokenScopes: null,
            tokenExpiresAt: null,
            tokenLastRefreshedAt: null,
            tokenLastValidatedAt: new Date(),
            oauthConnectedAt: null,
          } : {}),
        },
        select: { id: true },
      });

      if (parsed.accessToken) {
        await upsertAccountCredential(tx, account.id, parsed.accessToken);
      }

      await tx.auditEvent.create({
        data: {
          accountId: account.id,
          actorType: 'admin',
          actorId: actorId(request),
          action: 'account.created',
          entityType: 'account',
          entityId: String(account.id),
          metadata: { role: parsed.data.role ?? 'automation' },
          userAgent: request.headers.get('user-agent'),
        },
      });

      return account.id;
    });

    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      include: { credential: { select: credentialPresenceSelect } },
    });
    return NextResponse.json(sanitizeAccount(account), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
