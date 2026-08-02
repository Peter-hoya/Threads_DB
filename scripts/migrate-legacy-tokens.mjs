import crypto from 'node:crypto';
import prismaPackage from '@prisma/client';

const { PrismaClient } = prismaPackage;
const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

function encryptionKey() {
  const value = process.env.THREADS_TOKEN_ENCRYPTION_KEY?.trim();
  if (!value) throw new Error('THREADS_TOKEN_ENCRYPTION_KEY is required.');
  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, value.includes('-') || value.includes('_') ? 'base64url' : 'base64');
  if (key.length !== 32) {
    throw new Error('THREADS_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return key;
}

function encryptToken(token, accountId, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`threads-account:${accountId}:v1`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    encryptedAccessToken: ciphertext.toString('base64url'),
    accessTokenIv: iv.toString('base64url'),
    accessTokenAuthTag: cipher.getAuthTag().toString('base64url'),
    encryptionVersion: 1,
    tokenFingerprint: crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16),
  };
}

async function main() {
  const key = encryptionKey();
  const accounts = await prisma.account.findMany({
    where: { threadsAccessToken: { not: null } },
    select: { id: true, accountName: true, threadsAccessToken: true },
    orderBy: { id: 'asc' },
  });

  console.log(`${dryRun ? '[dry-run] ' : ''}${accounts.length} legacy token(s) found.`);

  for (const account of accounts) {
    if (!account.threadsAccessToken?.trim()) {
      if (!dryRun) {
        await prisma.account.update({
          where: { id: account.id },
          data: { threadsAccessToken: null },
        });
      }
      console.log(`Account ${account.id} (${account.accountName}): empty legacy value cleared.`);
      continue;
    }

    if (dryRun) {
      console.log(`Account ${account.id} (${account.accountName}): ready to encrypt.`);
      continue;
    }

    const encrypted = encryptToken(account.threadsAccessToken.trim(), account.id, key);
    await prisma.$transaction(async (tx) => {
      await tx.accountCredential.upsert({
        where: { accountId: account.id },
        create: { accountId: account.id, ...encrypted },
        update: encrypted,
      });
      await tx.account.update({
        where: { id: account.id },
        data: {
          threadsAccessToken: null,
          tokenStatus: 'active',
          tokenLastValidatedAt: null,
        },
      });
      await tx.auditEvent.create({
        data: {
          accountId: account.id,
          actorType: 'migration',
          actorId: 'migrate-legacy-tokens',
          action: 'account.credential_encrypted',
          entityType: 'account',
          entityId: String(account.id),
          metadata: { encryptionVersion: 1 },
        },
      });
    });
    console.log(`Account ${account.id} (${account.accountName}): encrypted and plaintext cleared.`);
  }

  console.log(dryRun ? 'Dry run complete; no data changed.' : 'Legacy token migration complete.');
}

main()
  .catch((error) => {
    console.error(`Legacy token migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
