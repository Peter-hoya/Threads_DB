import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsRoot = path.join(root, 'prisma', 'migrations');

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function migrationId(checksum) {
  const hex = checksum.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const entries = await readdir(migrationsRoot, { withFileTypes: true });
const migrationNames = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (migrationNames.length === 0) {
  throw new Error('No Prisma migrations were found.');
}

const migrations = [];
for (const name of migrationNames) {
  const sql = await readFile(path.join(migrationsRoot, name, 'migration.sql'), 'utf8');
  migrations.push({
    name,
    sql: sql.trim(),
    checksum: createHash('sha256').update(sql).digest('hex'),
  });
}

const output = [
  '-- Generated from prisma/migrations by scripts/build-neon-migration-bundle.mjs.',
  '-- It applies the schema and records the exact Prisma checksums atomically.',
  'BEGIN;',
];

for (const migration of migrations) {
  output.push(`\n-- Prisma migration: ${migration.name}\n${migration.sql}\n`);
}

output.push(`
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);
`);

for (const migration of migrations) {
  output.push(`
INSERT INTO "_prisma_migrations" (
  "id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count"
)
SELECT
  ${sqlLiteral(migrationId(migration.checksum))},
  ${sqlLiteral(migration.checksum)},
  NOW(),
  ${sqlLiteral(migration.name)},
  NOW(),
  1
WHERE NOT EXISTS (
  SELECT 1
  FROM "_prisma_migrations"
  WHERE "migration_name" = ${sqlLiteral(migration.name)}
);
`);
}

output.push('\nCOMMIT;\n');
process.stdout.write(output.join('\n'));
