import { createHmac, timingSafeEqual } from 'node:crypto';

export class MetaCallbackError extends Error {
  constructor(message, { status = 400, code = 'INVALID_META_CALLBACK' } = {}) {
    super(message);
    this.name = 'MetaCallbackError';
    this.status = status;
    this.code = code;
  }
}

function requireAppSecret(env = process.env) {
  const secret = env.THREADS_APP_SECRET;
  if (!secret) {
    throw new MetaCallbackError('Threads 앱 Secret이 설정되지 않았습니다.', {
      status: 503,
      code: 'THREADS_APP_SECRET_MISSING',
    });
  }
  return secret;
}

export function verifyMetaSignedRequest(signedRequest, env = process.env) {
  if (typeof signedRequest !== 'string' || signedRequest.length > 16_384) {
    throw new MetaCallbackError('Meta signed_request가 필요합니다.', {
      code: 'SIGNED_REQUEST_MISSING',
    });
  }

  const parts = signedRequest.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new MetaCallbackError('Meta signed_request 형식이 올바르지 않습니다.', {
      code: 'SIGNED_REQUEST_INVALID',
    });
  }

  const [encodedSignature, encodedPayload] = parts;
  let suppliedSignature;
  let payload;
  try {
    suppliedSignature = Buffer.from(encodedSignature, 'base64url');
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new MetaCallbackError('Meta signed_request를 해석할 수 없습니다.', {
      code: 'SIGNED_REQUEST_INVALID',
    });
  }

  if (String(payload?.algorithm || '').toUpperCase() !== 'HMAC-SHA256') {
    throw new MetaCallbackError('지원하지 않는 Meta 서명 알고리즘입니다.', {
      code: 'SIGNED_REQUEST_ALGORITHM_INVALID',
    });
  }

  const expectedSignature = createHmac('sha256', requireAppSecret(env))
    .update(encodedPayload, 'utf8')
    .digest();
  if (
    suppliedSignature.length !== expectedSignature.length
    || !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new MetaCallbackError('Meta signed_request 서명이 올바르지 않습니다.', {
      code: 'SIGNED_REQUEST_SIGNATURE_INVALID',
    });
  }

  const userId = payload?.user_id === undefined || payload?.user_id === null
    ? ''
    : String(payload.user_id).trim();
  if (!userId || userId.length > 255) {
    throw new MetaCallbackError('Meta 사용자 ID가 없습니다.', {
      code: 'META_USER_ID_MISSING',
    });
  }

  return { ...payload, user_id: userId };
}

export async function readAndVerifyMetaSignedRequest(request, env = process.env) {
  const contentType = String(request.headers.get('content-type') || '').toLowerCase();
  const rawBody = await request.text();
  if (rawBody.length > 20_000) {
    throw new MetaCallbackError('Meta 콜백 요청이 너무 큽니다.', {
      status: 413,
      code: 'META_CALLBACK_TOO_LARGE',
    });
  }

  let signedRequest = '';
  if (contentType.includes('application/json')) {
    try {
      signedRequest = JSON.parse(rawBody)?.signed_request || '';
    } catch {
      throw new MetaCallbackError('Meta 콜백 JSON이 올바르지 않습니다.', {
        code: 'META_CALLBACK_JSON_INVALID',
      });
    }
  } else {
    signedRequest = new URLSearchParams(rawBody).get('signed_request') || '';
  }
  return verifyMetaSignedRequest(signedRequest, env);
}

export function dataDeletionConfirmationCode(userId, env = process.env) {
  return createHmac('sha256', requireAppSecret(env))
    .update(`threads-data-deletion:${String(userId)}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export function metaCallbackErrorResponse(error) {
  const known = error instanceof MetaCallbackError;
  if (!known) console.error('Meta callback failed:', error?.message ?? error);
  return Response.json({
    success: false,
    error: known ? error.code : 'META_CALLBACK_FAILED',
  }, {
    status: known ? error.status : 500,
    headers: { 'Cache-Control': 'no-store' },
  });
}
