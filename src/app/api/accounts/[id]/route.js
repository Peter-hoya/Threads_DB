import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import {
  credentialPresenceSelect,
  deleteAccountCredential,
  parseAccountWriteBody,
  sanitizeAccount,
  upsertAccountCredential,
  verifyManualThreadsToken,
} from '@/lib/account-credentials';
import { parseBasicAuthorization } from '@/lib/request-auth';

function parseId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

function actorId(request) {
  return parseBasicAuthorization(request)?.username ?? 'admin';
}

function apiError(error) {
  if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid JSON request body.' }, { status: 400 });
  if (error?.status) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error?.code === 'P2025') return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  if (error?.code === 'P2002') return NextResponse.json({ error: 'An account with this name already exists.' }, { status: 409 });
  console.error('Account API error:', error?.message ?? error);
  return NextResponse.json({ error: 'Unable to process the account request.' }, { status: 500 });
}

export async function PATCH(request, { params }) {
  try {
    const { id: idParam } = await params;
    const id = parseId(idParam);
    if (!id) return NextResponse.json({ error: 'Invalid account id.' }, { status: 400 });

    const parsed = parseAccountWriteBody(await request.json(), { partial: true });
    const existing = await prisma.account.findUnique({
      where: { id },
      include: { credential: { select: credentialPresenceSelect } },
    });
    if (!existing) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });

    const verifiedProfile = parsed.accessToken
      ? await verifyManualThreadsToken(parsed.accessToken, existing.threadsUserId)
      : null;

    if (verifiedProfile && verifiedProfile.id !== existing.threadsUserId) {
      const duplicateProfile = await prisma.account.findFirst({
        where: { threadsUserId: verifiedProfile.id, id: { not: id } },
        select: { id: true },
      });
      if (duplicateProfile) {
        return NextResponse.json(
          { error: 'This Threads profile is already connected to another account.' },
          { status: 409 },
        );
      }
    }

    const resolvedRole = parsed.data.role ?? existing.role;
    const willHaveToken = parsed.accessToken === null
      ? false
      : Boolean(parsed.accessToken || existing.credential || existing.threadsAccessToken);

    if (resolvedRole === 'primary' && parsed.data.postingEnabled) {
      return NextResponse.json(
        { error: 'The primary account must remain manual (postingEnabled=false).' },
        { status: 400 },
      );
    }
    if (parsed.data.postingEnabled && !willHaveToken) {
      return NextResponse.json(
        { error: 'Connect a Threads token before enabling automatic posting.' },
        { status: 400 },
      );
    }

    await prisma.$transaction(async (tx) => {
      const accountData = {
        ...parsed.data,
        ...(verifiedProfile ? {
          threadsUserId: verifiedProfile.id,
          threadsUsername: verifiedProfile.username,
        } : {}),
        ...(resolvedRole === 'primary' ? { postingEnabled: false } : {}),
      };

      if (parsed.accessToken) {
        Object.assign(accountData, {
          tokenStatus: 'active',
          tokenType: 'manual_bearer',
          tokenScopes: null,
          tokenExpiresAt: null,
          tokenLastRefreshedAt: null,
          tokenLastValidatedAt: new Date(),
          oauthConnectedAt: null,
        });
      } else if (parsed.accessToken === null) {
        accountData.postingEnabled = false;
      }

      await tx.account.update({ where: { id }, data: accountData });

      if (parsed.accessToken) {
        await upsertAccountCredential(tx, id, parsed.accessToken);
      } else if (parsed.accessToken === null) {
        await deleteAccountCredential(tx, id);
      }

      await tx.auditEvent.create({
        data: {
          accountId: id,
          actorType: 'admin',
          actorId: actorId(request),
          action: parsed.accessToken ? 'account.credential_replaced' : 'account.updated',
          entityType: 'account',
          entityId: String(id),
          metadata: {
            changedFields: Object.keys(parsed.data),
            credentialRemoved: parsed.accessToken === null,
          },
          userAgent: request.headers.get('user-agent'),
        },
      });
    });

    const account = await prisma.account.findUniqueOrThrow({
      where: { id },
      include: { credential: { select: credentialPresenceSelect } },
    });
    return NextResponse.json(sanitizeAccount(account));
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id: idParam } = await params;
    const id = parseId(idParam);
    if (!id) return NextResponse.json({ error: 'Invalid account id.' }, { status: 400 });

    await prisma.$transaction(async (tx) => {
      const existing = await tx.account.findUnique({
        where: { id },
        select: {
          id: true,
          accountName: true,
          credential: { select: { accountId: true } },
          _count: {
            select: {
              posts: true,
              templates: true,
              jobs: true,
            },
          },
        },
      });
      if (!existing) {
        const error = new Error('Account not found.');
        error.status = 404;
        throw error;
      }
      if (
        existing.credential
        || existing._count.posts > 0
        || existing._count.templates > 0
        || existing._count.jobs > 0
      ) {
        const error = new Error('This account has credentials, content, or history. Disconnect and deactivate it instead of deleting it.');
        error.status = 409;
        throw error;
      }

      await tx.auditEvent.create({
        data: {
          accountId: id,
          actorType: 'admin',
          actorId: actorId(request),
          action: 'account.deleted',
          entityType: 'account',
          entityId: String(id),
          metadata: { accountName: existing.accountName },
          userAgent: request.headers.get('user-agent'),
        },
      });
      await tx.account.delete({ where: { id } });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}
