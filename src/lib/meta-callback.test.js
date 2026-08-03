import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  dataDeletionConfirmationCode,
  readAndVerifyMetaSignedRequest,
  verifyMetaSignedRequest,
} from './meta-callback.js';

const env = { THREADS_APP_SECRET: 'threads-app-secret' };

function signedRequest(payload) {
  const encodedPayload = Buffer.from(JSON.stringify({
    algorithm: 'HMAC-SHA256',
    ...payload,
  })).toString('base64url');
  const signature = createHmac('sha256', env.THREADS_APP_SECRET)
    .update(encodedPayload)
    .digest('base64url');
  return `${signature}.${encodedPayload}`;
}

test('Meta signed_request 서명을 검증하고 사용자 ID를 읽는다', () => {
  const payload = verifyMetaSignedRequest(signedRequest({ user_id: 12345 }), env);
  assert.equal(payload.user_id, '12345');
});

test('변조된 Meta signed_request를 거부한다', () => {
  const value = signedRequest({ user_id: 'user-1' });
  assert.throws(
    () => verifyMetaSignedRequest(`${value.slice(0, -1)}x`, env),
    /서명|해석/,
  );
});

test('폼 형식 콜백을 읽고 삭제 확인 코드를 안정적으로 생성한다', async () => {
  const value = signedRequest({ user_id: 'user-7' });
  const request = new Request('https://admin.example/api/oauth/data-deletion', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ signed_request: value }),
  });
  const payload = await readAndVerifyMetaSignedRequest(request, env);
  assert.equal(payload.user_id, 'user-7');
  const code = dataDeletionConfirmationCode(payload.user_id, env);
  assert.match(code, /^[a-f0-9]{32}$/);
  assert.equal(code, dataDeletionConfirmationCode(payload.user_id, env));
  assert.doesNotMatch(code, /user-7/);
});
