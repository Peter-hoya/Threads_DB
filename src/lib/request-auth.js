import { createHash, timingSafeEqual } from 'node:crypto';

function hashForComparison(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

export function secureStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return timingSafeEqual(hashForComparison(left), hashForComparison(right));
}

function authorizationHeader(request) {
  return request?.headers?.get?.('authorization') ?? null;
}

export function parseBasicAuthorization(request) {
  const header = authorizationHeader(request);
  if (!header || header.length > 16_384) return null;
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match) return null;

  try {
    const decoded = Buffer.from(match[1].trim(), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 1) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export function getAdminBasicAuthConfig(env = process.env) {
  // The ADMIN_BASIC_AUTH_* names are canonical. ADMIN_USERNAME/PASSWORD are
  // supported so existing deployments can migrate without an outage.
  const username = env.ADMIN_BASIC_AUTH_USERNAME ?? env.ADMIN_USERNAME ?? '';
  const password = env.ADMIN_BASIC_AUTH_PASSWORD ?? env.ADMIN_PASSWORD ?? '';
  return {
    username,
    password,
    configured: Boolean(username && password),
  };
}

export function authenticateAdminRequest(request, options = {}) {
  const env = options.env ?? process.env;
  const isProduction = (options.nodeEnv ?? env.NODE_ENV) === 'production';
  const config = getAdminBasicAuthConfig(env);

  if (!config.configured) {
    if (!isProduction && options.allowUnconfiguredInDevelopment !== false) {
      return { ok: true, mode: 'development-bypass' };
    }
    return { ok: false, status: 503, code: 'admin_auth_not_configured' };
  }

  const supplied = parseBasicAuthorization(request);
  const usernameValid = secureStringEqual(supplied?.username ?? '', config.username);
  const passwordValid = secureStringEqual(supplied?.password ?? '', config.password);
  const valid = Boolean(supplied && usernameValid && passwordValid);

  if (!valid) {
    return { ok: false, status: 401, code: 'invalid_admin_credentials' };
  }

  return { ok: true, mode: 'basic', actorId: supplied.username };
}

export function authenticateMutationSource(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(request?.method || 'GET').toUpperCase())) {
    return { ok: true, mode: 'safe-method' };
  }

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') {
    return { ok: false, status: 403, code: 'cross_site_mutation_blocked' };
  }

  const expectedOrigin = new URL(request.url).origin;
  const suppliedOrigin = request.headers.get('origin');
  if (suppliedOrigin) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(suppliedOrigin).origin;
    } catch {
      return { ok: false, status: 403, code: 'invalid_mutation_origin' };
    }
    if (!secureStringEqual(parsedOrigin, expectedOrigin)) {
      return { ok: false, status: 403, code: 'cross_site_mutation_blocked' };
    }
    return { ok: true, mode: 'same-origin' };
  }

  if (fetchSite === 'same-origin') return { ok: true, mode: 'same-origin' };
  if (request.headers.get('x-threads-admin-request') === '1') {
    return { ok: true, mode: 'explicit-api-client' };
  }
  return { ok: false, status: 403, code: 'mutation_origin_required' };
}

export function extractBearerToken(request) {
  const header = authorizationHeader(request);
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

export function authenticateBearerRequest(request, secret, options = {}) {
  if (typeof secret !== 'string' || !secret) {
    return {
      ok: false,
      status: 503,
      code: options.missingCode ?? 'server_auth_not_configured',
    };
  }

  const supplied = extractBearerToken(request);
  if (!supplied || !secureStringEqual(supplied, secret)) {
    return {
      ok: false,
      status: 401,
      code: options.invalidCode ?? 'invalid_bearer_token',
    };
  }

  return { ok: true, mode: 'bearer' };
}

export function authenticateCronRequest(request, env = process.env) {
  return authenticateBearerRequest(request, env.CRON_SECRET, {
    missingCode: 'cron_auth_not_configured',
    invalidCode: 'invalid_cron_secret',
  });
}

export function authenticateInternalRequest(request, env = process.env) {
  return authenticateBearerRequest(request, env.INTERNAL_API_SECRET, {
    missingCode: 'internal_auth_not_configured',
    invalidCode: 'invalid_internal_secret',
  });
}

export function authErrorResponse(auth, options = {}) {
  const status = auth?.status ?? 401;
  const headers = { 'Cache-Control': 'no-store' };
  if (status === 401 && options.basicChallenge) {
    headers['WWW-Authenticate'] = 'Basic realm="Threads Admin", charset="UTF-8"';
  }

  return Response.json(
    { error: auth?.code ?? 'unauthorized' },
    { status, headers },
  );
}
