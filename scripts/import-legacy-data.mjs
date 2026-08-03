import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const printSql = process.argv.includes('--print-sql');
const IMPORT_MARKER = '기존 social_accounts에서 안전하게 가져온 Threads 계정';

const ACCOUNT_IMPORT_SQL = `
INSERT INTO accounts (
  account_name,
  description,
  threads_user_id,
  threads_username,
  role,
  posting_enabled,
  token_status,
  is_active,
  created_at,
  updated_at
)
SELECT
  legacy.account_name,
  '${IMPORT_MARKER}',
  legacy.external_account_id,
  legacy.account_handle,
  'primary',
  false,
  'missing',
  legacy.is_active,
  legacy.created_at AT TIME ZONE 'UTC',
  legacy.updated_at AT TIME ZONE 'UTC'
FROM social_accounts AS legacy
WHERE legacy.platform = 'threads'
ON CONFLICT (account_name) DO NOTHING
`;

const TEMPLATE_IMPORT_SQL = `
INSERT INTO templates (
  account_id,
  template_code,
  template_name,
  prompt_text,
  is_active,
  created_at,
  updated_at
)
SELECT
  account.id,
  legacy.template_code,
  legacy.template_name,
  COALESCE(NULLIF(BTRIM(legacy.prompt_text), ''), legacy.template_text),
  legacy.is_active,
  legacy.created_at AT TIME ZONE 'UTC',
  legacy.updated_at AT TIME ZONE 'UTC'
FROM content_templates AS legacy
JOIN social_accounts AS legacy_account
  ON legacy_account.id = legacy.account_id
 AND legacy_account.platform = 'threads'
JOIN accounts AS account
  ON account.account_name = legacy_account.account_name
WHERE COALESCE(NULLIF(BTRIM(legacy.prompt_text), ''), NULLIF(BTRIM(legacy.template_text), '')) IS NOT NULL
ON CONFLICT (account_id, template_code) DO NOTHING
`;

const POST_IMPORT_SQL = `
INSERT INTO posts (
  account_id,
  platform,
  content,
  template_id,
  status,
  approval_status,
  rights_confirmed,
  policy_review_confirmed,
  scheduled_at,
  published_at,
  post_id_external,
  publish_attempts,
  error_message,
  created_at,
  updated_at
)
SELECT
  account.id,
  'threads',
  legacy.content_text,
  current_template.id,
  CASE
    WHEN legacy.status = 'published' THEN 'published'
    WHEN legacy.status = 'failed' THEN 'failed'
    WHEN legacy.status = 'cancelled' THEN 'cancelled'
    ELSE 'draft'
  END,
  'draft',
  false,
  false,
  legacy.scheduled_at AT TIME ZONE 'UTC',
  CASE WHEN legacy.status = 'published' THEN legacy.published_at AT TIME ZONE 'UTC' ELSE NULL END,
  legacy.external_post_id,
  legacy.retry_count,
  legacy.last_error,
  legacy.created_at AT TIME ZONE 'UTC',
  legacy.updated_at AT TIME ZONE 'UTC'
FROM publish_queue AS legacy
JOIN social_accounts AS legacy_account
  ON legacy_account.id = legacy.account_id
 AND legacy_account.platform = 'threads'
JOIN accounts AS account
  ON account.account_name = legacy_account.account_name
LEFT JOIN content_templates AS legacy_template
  ON legacy_template.id = legacy.template_id
 AND legacy_template.account_id = legacy.account_id
LEFT JOIN templates AS current_template
  ON current_template.account_id = account.id
 AND current_template.template_code = legacy_template.template_code
WHERE legacy.platform = 'threads'
  AND NOT EXISTS (
    SELECT 1
    FROM posts AS current_post
    WHERE
      (legacy.external_post_id IS NOT NULL AND current_post.post_id_external = legacy.external_post_id)
      OR (
        current_post.account_id = account.id
        AND current_post.created_at = legacy.created_at AT TIME ZONE 'UTC'
        AND current_post.content = legacy.content_text
      )
  )
`;

async function tableExists(name, client = prisma) {
  const rows = await client.$queryRawUnsafe(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    `public.${name}`,
  );
  return Boolean(rows[0]?.exists);
}

async function count(name) {
  if (!(await tableExists(name))) return 0;
  if (!['social_accounts', 'content_templates', 'publish_queue', 'accounts', 'posts'].includes(name)) {
    throw new Error('Unexpected table name.');
  }
  const rows = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::integer AS count FROM ${name}`);
  return Number(rows[0]?.count || 0);
}

async function assertNoLegacyIdentityConflicts() {
  const conflicts = await prisma.$queryRawUnsafe(`
    SELECT legacy.account_name
    FROM social_accounts AS legacy
    JOIN accounts AS current_account
      ON current_account.account_name = legacy.account_name
    WHERE legacy.platform = 'threads'
      AND current_account.description IS DISTINCT FROM '${IMPORT_MARKER}'
    LIMIT 10
  `);
  if (conflicts.length) {
    throw new Error(`기존 accounts 이름과 legacy Threads 계정이 충돌합니다: ${conflicts.map((row) => row.account_name).join(', ')}`);
  }

  const profileConflicts = await prisma.$queryRawUnsafe(`
    SELECT legacy.account_name
    FROM social_accounts AS legacy
    JOIN accounts AS current_account
      ON current_account.threads_user_id = legacy.external_account_id
    WHERE legacy.platform = 'threads'
      AND legacy.external_account_id IS NOT NULL
      AND current_account.account_name <> legacy.account_name
    LIMIT 10
  `);
  if (profileConflicts.length) {
    throw new Error(`Threads User ID가 다른 이름의 계정과 충돌합니다: ${profileConflicts.map((row) => row.account_name).join(', ')}`);
  }
}

async function main() {
  if (printSql) {
    console.log(JSON.stringify([ACCOUNT_IMPORT_SQL, TEMPLATE_IMPORT_SQL, POST_IMPORT_SQL]));
    return;
  }

  const source = {
    accounts: await tableExists('social_accounts'),
    templates: await tableExists('content_templates'),
    posts: await tableExists('publish_queue'),
  };
  const before = {
    legacyAccounts: await count('social_accounts'),
    legacyTemplates: await count('content_templates'),
    legacyPosts: await count('publish_queue'),
    currentAccounts: await count('accounts'),
    currentPosts: await count('posts'),
  };

  if (!apply) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      source,
      before,
      next: '--apply를 추가하면 Threads 비밀정보를 제외한 계정·템플릿·발행이력을 UTC로 가져옵니다.',
    }, null, 2));
    return;
  }
  if (!source.accounts) throw new Error('social_accounts 테이블이 없어 legacy import를 실행할 수 없습니다.');

  await assertNoLegacyIdentityConflicts();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(ACCOUNT_IMPORT_SQL);
    if (source.templates) await tx.$executeRawUnsafe(TEMPLATE_IMPORT_SQL);
    if (source.posts) await tx.$executeRawUnsafe(POST_IMPORT_SQL);
  }, { timeout: 60_000 });

  const after = {
    currentAccounts: await count('accounts'),
    currentPosts: await count('posts'),
  };
  console.log(JSON.stringify({ mode: 'applied', before, after, credentialsImported: false }, null, 2));
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
