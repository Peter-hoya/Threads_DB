import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

const AUTHORIZE_URL = 'https://threads.net/oauth/authorize';
const DEFAULT_SCOPES = [
  'threads_basic',
  'threads_content_publish',
  'threads_manage_replies',
  'threads_read_replies',
];
const ALLOWED_SCOPES = new Set([
  ...DEFAULT_SCOPES,
  'threads_manage_insights',
]);

function stateHash(state) {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function configuredScopes(env = process.env) {
  const requested = (env.THREADS_OAUTH_SCOPES || DEFAULT_SCOPES.join(','))
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  const scopes = [...new Set([...DEFAULT_SCOPES, ...requested])];
  if (scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    throw new Error('THREADS_OAUTH_SCOPES contains an unsupported scope.');
  }
  return scopes;
}

function oauthConfig(request) {
  const appId = process.env.THREADS_APP_ID;
  const redirectUri = process.env.THREADS_OAUTH_REDIRECT_URI
    || (process.env.NODE_ENV === 'production'
      ? null
      : new URL('/api/oauth/callback', request.url).toString());

  if (!appId || !redirectUri) {
    throw new Error('Threads OAuth is not configured.');
  }
  return { appId, redirectUri, scopes: configuredScopes() };
}

function safeReturnTo(value) {
  if (
    !value
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\\')
    || /[\u0000-\u001F\u007F]/.test(value)
  ) return '/accounts';
  return value.slice(0, 1000);
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const accountId = Number(searchParams.get('accountId'));
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      return NextResponse.json({ error: 'A valid accountId is required.' }, { status: 400 });
    }

    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true },
    });
    if (!account) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });

    const { appId, redirectUri, scopes } = oauthConfig(request);
    const rawState = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.$transaction([
      prisma.oAuthState.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: new Date() } },
            { usedAt: { not: null }, createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
          ],
        },
      }),
      prisma.oAuthState.create({
        data: {
          stateHash: stateHash(rawState),
          accountId,
          redirectUri,
          returnTo: safeReturnTo(searchParams.get('returnTo')),
          metadata: { scopes },
          expiresAt,
        },
      }),
    ]);

    const authorizeUrl = new URL(AUTHORIZE_URL);
    authorizeUrl.searchParams.set('client_id', appId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', scopes.join(','));
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('state', rawState);

    const response = NextResponse.redirect(authorizeUrl);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    console.error('Threads OAuth start error:', error?.message ?? error);
    return NextResponse.json(
      { error: 'Threads OAuth is unavailable. Check the server configuration.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
