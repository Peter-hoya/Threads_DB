import { NextResponse } from 'next/server';
import { authenticateAdminRequest, authenticateMutationSource } from '@/lib/request-auth';

const PUBLIC_SERVER_PATHS = [
  '/api/cron/',
  '/api/internal/',
];

const PUBLIC_EXACT_PATHS = new Set([
  '/api/oauth/callback',
  '/api/oauth/deauthorize',
  '/api/oauth/data-deletion',
  '/api/upload/cleanup',
  '/data-deletion',
]);

function isPublicServerRequest(request) {
  const { pathname } = request.nextUrl;
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  if (PUBLIC_EXACT_PATHS.has(normalizedPath)) return true;
  const explicit = PUBLIC_SERVER_PATHS.some((path) => (
    path.endsWith('/') ? pathname.startsWith(path) : pathname === path
  ));
  if (explicit) return true;

  // Only the legacy immutable blob itself is public. Administrative media APIs
  // such as /api/media/verify remain behind Basic Auth.
  return ['GET', 'HEAD'].includes(request.method)
    && /^\/api\/media\/[A-Za-z0-9._-]{1,255}$/.test(pathname)
    && pathname !== '/api/media/verify';
}

export function proxy(request) {
  if (isPublicServerRequest(request)) {
    // These routes enforce OAuth state or bearer auth themselves. Media URLs must
    // remain publicly fetchable for the Threads API.
    return NextResponse.next();
  }

  const mutation = authenticateMutationSource(request);
  if (!mutation.ok) {
    return NextResponse.json(
      { error: mutation.code },
      { status: mutation.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const auth = authenticateAdminRequest(request);
  if (auth.ok) return NextResponse.next();

  const headers = { 'Cache-Control': 'no-store' };
  if (auth.status === 401) {
    headers['WWW-Authenticate'] = 'Basic realm="Threads Admin", charset="UTF-8"';
  }

  return NextResponse.json(
    { error: auth.code },
    { status: auth.status, headers },
  );
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
};
