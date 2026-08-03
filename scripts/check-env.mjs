const MODES = {
  core: [
    'NETLIFY_DATABASE_URL',
    'DIRECT_DATABASE_URL',
    'ADMIN_BASIC_AUTH_USERNAME',
    'ADMIN_BASIC_AUTH_PASSWORD',
    'THREADS_TOKEN_ENCRYPTION_KEY',
    'CRON_SECRET',
  ],
  oauth: [
    'THREADS_APP_ID',
    'THREADS_APP_SECRET',
    'THREADS_OAUTH_REDIRECT_URI',
  ],
  media: [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'UPLOAD_SIGNING_SECRET',
    'INTERNAL_API_SECRET',
  ],
  worker: [
    'NETLIFY_DATABASE_URL',
    'THREADS_TOKEN_ENCRYPTION_KEY',
    'SUPABASE_URL',
  ],
  ai: [
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
  ],
};

function selectedNames() {
  const argument = process.argv.find((value) => value.startsWith('--mode='));
  const mode = argument?.slice('--mode='.length) || 'all';
  if (mode === 'all') {
    return [...new Set(['core', 'oauth', 'media', 'worker'].flatMap((name) => MODES[name]))];
  }
  if (!MODES[mode]) {
    throw new Error(`지원하지 않는 mode입니다: ${mode}. core, oauth, media, worker, ai, all 중 하나를 사용하세요.`);
  }
  return MODES[mode];
}

function isPlaceholder(value) {
  return !value || /REPLACE_WITH|YOUR_|USER:PASSWORD|POOLER_HOST|DIRECT_HOST/i.test(value);
}

function assertUrl(name, value, protocols) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} URL 형식이 올바르지 않습니다.`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} 프로토콜이 올바르지 않습니다.`);
  }
}

function assertEncryptionKey(value) {
  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, value.includes('-') || value.includes('_') ? 'base64url' : 'base64');
  if (key.length !== 32) throw new Error('THREADS_TOKEN_ENCRYPTION_KEY는 정확히 32바이트여야 합니다.');
}

try {
  const names = selectedNames();
  const missing = names.filter((name) => isPlaceholder(process.env[name]));
  if (missing.length) {
    throw new Error(`누락되었거나 placeholder인 환경 변수: ${missing.join(', ')}`);
  }

  for (const name of ['NETLIFY_DATABASE_URL', 'DIRECT_DATABASE_URL']) {
    if (names.includes(name)) assertUrl(name, process.env[name], ['postgresql:', 'postgres:']);
  }
  for (const name of ['THREADS_OAUTH_REDIRECT_URI', 'SUPABASE_URL']) {
    if (names.includes(name)) assertUrl(name, process.env[name], ['https:']);
  }
  if (names.includes('THREADS_TOKEN_ENCRYPTION_KEY')) {
    assertEncryptionKey(process.env.THREADS_TOKEN_ENCRYPTION_KEY);
  }
  if (names.includes('ADMIN_BASIC_AUTH_PASSWORD') && process.env.ADMIN_BASIC_AUTH_PASSWORD.length < 16) {
    throw new Error('ADMIN_BASIC_AUTH_PASSWORD는 최소 16자로 설정하세요.');
  }
  const serverSecrets = ['UPLOAD_SIGNING_SECRET', 'CRON_SECRET', 'INTERNAL_API_SECRET']
    .filter((name) => names.includes(name));
  for (const name of serverSecrets) {
    if (process.env[name].length < 32) throw new Error(`${name}는 최소 32자로 설정하세요.`);
  }
  if (new Set(serverSecrets.map((name) => process.env[name])).size !== serverSecrets.length) {
    throw new Error('UPLOAD_SIGNING_SECRET, CRON_SECRET, INTERNAL_API_SECRET는 서로 다른 값이어야 합니다.');
  }

  console.log(`환경 변수 검증 통과 (${names.length}개, 비밀값은 출력하지 않음).`);
} catch (error) {
  console.error(`환경 변수 검증 실패: ${error.message}`);
  process.exitCode = 1;
}
