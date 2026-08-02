import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { upsertAccountCredential } from '@/lib/account-credentials';

const GRAPH_BASE_URL = 'https://graph.threads.net';

class OAuthStepError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function stateHash(state) {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function safeReturnUrl(request, oauthState, params) {
  const path = oauthState?.returnTo?.startsWith('/')
    && !oauthState.returnTo.startsWith('//')
    && !oauthState.returnTo.includes('\\')
    ? oauthState.returnTo
    : '/accounts';
  const requestUrl = new URL(request.url);
  let target = new URL(path, requestUrl.origin);
  if (target.origin !== requestUrl.origin) target = new URL('/accounts', requestUrl.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) target.searchParams.set(key, String(value));
  }
  return target;
}

function noStoreRedirect(url) {
  const response = NextResponse.redirect(url);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

async function responseJson(response, errorCode) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new OAuthStepError(errorCode, 502);
  }
  if (!response.ok) throw new OAuthStepError(errorCode, response.status >= 500 ? 502 : 400);
  return data;
}

async function exchangeAuthorizationCode(code, redirectUri) {
  const appId = process.env.THREADS_APP_ID;
  const appSecret = process.env.THREADS_APP_SECRET;
  if (!appId || !appSecret) throw new OAuthStepError('oauth_server_not_configured', 503);

  const body = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });
  const response = await fetch(`${GRAPH_BASE_URL}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  const data = await responseJson(response, 'short_token_exchange_failed');
  if (!data.access_token || !data.user_id) throw new OAuthStepError('invalid_short_token_response');
  return data;
}

async function exchangeLongLivedToken(shortToken) {
  const url = new URL(`${GRAPH_BASE_URL}/access_token`);
  url.searchParams.set('grant_type', 'th_exchange_token');
  url.searchParams.set('client_secret', process.env.THREADS_APP_SECRET);
  url.searchParams.set('access_token', shortToken);
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  const data = await responseJson(response, 'long_token_exchange_failed');
  if (!data.access_token || !Number.isFinite(Number(data.expires_in))) {
    throw new OAuthStepError('invalid_long_token_response');
  }
  return data;
}

async function fetchThreadsProfile(accessToken) {
  const url = new URL(`${GRAPH_BASE_URL}/v1.0/me`);
  url.searchParams.set('fields', 'id,username');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  const data = await responseJson(response, 'profile_verification_failed');
  if (!data.id || !data.username) throw new OAuthStepError('invalid_profile_response');
  return data;
}

async function consumeOAuthState(rawState) {
  const hash = stateHash(rawState);
  const now = new Date();
  const consumed = await prisma.oAuthState.updateMany({
    where: { stateHash: hash, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (consumed.count !== 1) return null;
  return prisma.oAuthState.findUnique({ where: { stateHash: hash } });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const rawState = searchParams.get('state');
  if (!rawState || rawState.length > 512) {
    return NextResponse.json({ error: 'invalid_oauth_state' }, { status: 400 });
  }

  let oauthState;
  try {
    // Atomic updateMany makes state single-use even when callbacks race.
    oauthState = await consumeOAuthState(rawState);
  } catch (error) {
    console.error('OAuth state lookup failed:', error?.message ?? error);
    return NextResponse.json({ error: 'oauth_state_unavailable' }, { status: 503 });
  }
  if (!oauthState?.accountId) {
    return NextResponse.json({ error: 'invalid_or_expired_oauth_state' }, { status: 400 });
  }

  if (searchParams.get('error')) {
    return noStoreRedirect(safeReturnUrl(request, oauthState, {
      oauth: 'error',
      reason: 'authorization_denied',
    }));
  }

  const code = searchParams.get('code');
  if (!code || code.length > 4096) {
    return noStoreRedirect(safeReturnUrl(request, oauthState, {
      oauth: 'error',
      reason: 'missing_authorization_code',
    }));
  }

  try {
    const shortToken = await exchangeAuthorizationCode(code, oauthState.redirectUri);
    const longToken = await exchangeLongLivedToken(shortToken.access_token);
    const profile = await fetchThreadsProfile(longToken.access_token);

    if (String(shortToken.user_id) !== String(profile.id)) {
      throw new OAuthStepError('oauth_profile_mismatch', 400);
    }

    const [account, duplicateProfile] = await Promise.all([
      prisma.account.findUnique({
        where: { id: oauthState.accountId },
        select: { id: true, threadsUserId: true },
      }),
      prisma.account.findFirst({
        where: {
          threadsUserId: String(profile.id),
          id: { not: oauthState.accountId },
        },
        select: { id: true },
      }),
    ]);
    if (!account) throw new OAuthStepError('account_not_found', 404);
    if (duplicateProfile) throw new OAuthStepError('threads_profile_already_connected', 409);
    if (account.threadsUserId && String(account.threadsUserId) !== String(profile.id)) {
      throw new OAuthStepError('account_identity_mismatch', 409);
    }

    const expiresInSeconds = Number(longToken.expires_in);
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const requestedScopes = Array.isArray(oauthState.metadata?.scopes)
      ? oauthState.metadata.scopes.join(',')
      : null;

    await prisma.$transaction(async (tx) => {
      await tx.account.update({
        where: { id: account.id },
        data: {
          threadsUserId: String(profile.id),
          threadsUsername: profile.username,
          tokenStatus: 'active',
          tokenType: longToken.token_type || 'bearer',
          // OAuth state records what was requested, not what Meta actually
          // granted. Keep the verified-scope field null until introspection is
          // added rather than overstating permissions.
          tokenScopes: null,
          tokenExpiresAt: expiresAt,
          tokenLastRefreshedAt: new Date(),
          tokenLastValidatedAt: new Date(),
          oauthConnectedAt: new Date(),
        },
      });
      await upsertAccountCredential(tx, account.id, longToken.access_token);
      await tx.auditEvent.create({
        data: {
          accountId: account.id,
          actorType: 'oauth',
          actorId: profile.username,
          action: 'account.oauth_connected',
          entityType: 'account',
          entityId: String(account.id),
          metadata: {
            threadsUserId: String(profile.id),
            threadsUsername: profile.username,
            expiresAt: expiresAt.toISOString(),
            requestedScopes,
          },
          userAgent: request.headers.get('user-agent'),
        },
      });
    });

    return noStoreRedirect(safeReturnUrl(request, oauthState, {
      oauth: 'connected',
      accountId: account.id,
    }));
  } catch (error) {
    const reason = error instanceof OAuthStepError ? error.code : 'oauth_callback_failed';
    console.error('Threads OAuth callback failed:', reason);
    return noStoreRedirect(safeReturnUrl(request, oauthState, {
      oauth: 'error',
      reason,
    }));
  }
}
