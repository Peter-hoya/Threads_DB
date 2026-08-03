-- This migration is intentionally additive. The legacy plaintext token column is
-- retained temporarily so scripts/migrate-legacy-tokens.mjs can encrypt existing
-- values before clearing them.

-- Account safety and operating policy
ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "threads_username" TEXT,
  ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'automation',
  ADD COLUMN IF NOT EXISTS "posting_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'Asia/Seoul',
  ADD COLUMN IF NOT EXISTS "operating_start_minute" INTEGER NOT NULL DEFAULT 420,
  ADD COLUMN IF NOT EXISTS "operating_end_minute" INTEGER NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS "daily_post_limit" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS "token_status" TEXT NOT NULL DEFAULT 'missing',
  ADD COLUMN IF NOT EXISTS "token_type" TEXT,
  ADD COLUMN IF NOT EXISTS "token_scopes" TEXT,
  ADD COLUMN IF NOT EXISTS "token_expires_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "token_last_refreshed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "token_last_validated_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "oauth_connected_at" TIMESTAMP(3);

ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_role_check"
    CHECK ("role" IN ('primary', 'automation')),
  ADD CONSTRAINT "accounts_primary_manual_check"
    CHECK ("role" <> 'primary' OR "posting_enabled" = false),
  ADD CONSTRAINT "accounts_operating_minutes_check"
    CHECK (
      "operating_start_minute" BETWEEN 0 AND 1439
      AND "operating_end_minute" BETWEEN 0 AND 1439
    ),
  ADD CONSTRAINT "accounts_daily_post_limit_check"
    CHECK ("daily_post_limit" BETWEEN 1 AND 100),
  ADD CONSTRAINT "accounts_token_status_check"
    CHECK ("token_status" IN ('missing', 'active', 'expiring', 'expired', 'invalid'));

CREATE UNIQUE INDEX IF NOT EXISTS "accounts_threads_user_id_key"
  ON "accounts"("threads_user_id");

-- AES-256-GCM ciphertext storage (one credential per account)
CREATE TABLE "account_credentials" (
  "account_id" INTEGER NOT NULL,
  "encrypted_access_token" TEXT NOT NULL,
  "access_token_iv" TEXT NOT NULL,
  "access_token_auth_tag" TEXT NOT NULL,
  "encryption_version" INTEGER NOT NULL DEFAULT 1,
  "token_fingerprint" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "account_credentials_pkey" PRIMARY KEY ("account_id"),
  CONSTRAINT "account_credentials_encryption_version_check"
    CHECK ("encryption_version" = 1),
  CONSTRAINT "account_credentials_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Single-use OAuth state. Only a SHA-256 state hash is persisted.
CREATE TABLE "oauth_states" (
  "id" TEXT NOT NULL,
  "state_hash" TEXT NOT NULL,
  "account_id" INTEGER,
  "redirect_uri" TEXT NOT NULL,
  "return_to" TEXT,
  "metadata" JSONB,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "oauth_states_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "oauth_states_state_hash_key"
  ON "oauth_states"("state_hash");
CREATE INDEX "oauth_states_expires_at_used_at_idx"
  ON "oauth_states"("expires_at", "used_at");

-- Approval, policy and idempotency fields for publishable content
ALTER TABLE "posts"
  ADD COLUMN IF NOT EXISTS "approval_status" TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approved_by" TEXT,
  ADD COLUMN IF NOT EXISTS "rights_confirmed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "policy_review_confirmed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "affiliate_disclosure" TEXT,
  ADD COLUMN IF NOT EXISTS "source_url" TEXT,
  ADD COLUMN IF NOT EXISTS "payload_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "content_fingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT,
  ADD COLUMN IF NOT EXISTS "container_id" TEXT,
  ADD COLUMN IF NOT EXISTS "container_created_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reply_container_id" TEXT,
  ADD COLUMN IF NOT EXISTS "reply_post_id_external" TEXT,
  ADD COLUMN IF NOT EXISTS "reply_published_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "needs_reconciliation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "reconciliation_note" TEXT,
  ADD COLUMN IF NOT EXISTS "publish_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_attempt_at" TIMESTAMP(3);

-- Previously queued rows must be reviewed and approved again before a worker can
-- publish them. Historical published/failed rows remain unchanged for reporting.
UPDATE "posts"
SET
  "status" = 'draft',
  "approval_status" = 'draft',
  "approved_at" = NULL,
  "approved_by" = NULL
WHERE "status" IN ('pending', 'scheduled');

-- Fail closed for any unrecognised legacy state as well.
UPDATE "posts"
SET "status" = 'draft', "approval_status" = 'draft'
WHERE "status" NOT IN ('draft', 'queued', 'publishing', 'published', 'failed', 'cancelled');

ALTER TABLE "posts" ALTER COLUMN "status" SET DEFAULT 'draft';

ALTER TABLE "posts"
  ADD CONSTRAINT "posts_status_check"
    CHECK ("status" IN ('draft', 'queued', 'publishing', 'published', 'failed', 'cancelled')),
  ADD CONSTRAINT "posts_approval_status_check"
    CHECK ("approval_status" IN ('draft', 'approved', 'rejected')),
  ADD CONSTRAINT "posts_approval_confirmations_check"
    CHECK (
      "approval_status" <> 'approved'
      OR ("rights_confirmed" = true AND "policy_review_confirmed" = true)
    ),
  ADD CONSTRAINT "posts_publish_attempts_check"
    CHECK ("publish_attempts" >= 0),
  ADD CONSTRAINT "posts_reconciliation_note_check"
    CHECK ("needs_reconciliation" = false OR "reconciliation_note" IS NOT NULL);

CREATE UNIQUE INDEX "posts_idempotency_key_key"
  ON "posts"("idempotency_key");
CREATE UNIQUE INDEX "posts_post_id_external_key"
  ON "posts"("post_id_external");
CREATE UNIQUE INDEX "posts_reply_post_id_external_key"
  ON "posts"("reply_post_id_external");
CREATE INDEX "posts_approval_status_status_scheduled_at_idx"
  ON "posts"("approval_status", "status", "scheduled_at");
CREATE INDEX "posts_payload_hash_idx"
  ON "posts"("payload_hash");
CREATE INDEX "posts_content_fingerprint_idx"
  ON "posts"("content_fingerprint");
CREATE UNIQUE INDEX "posts_active_content_fingerprint_key"
  ON "posts"("content_fingerprint")
  WHERE "content_fingerprint" IS NOT NULL
    AND "status" IN ('queued', 'publishing');

-- Durable worker queue. dedupe_key prevents duplicate publish/reply jobs.
CREATE TABLE "jobs" (
  "id" SERIAL NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "post_id" INTEGER,
  "account_id" INTEGER,
  "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dedupe_key" TEXT NOT NULL,
  "payload" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "locked_at" TIMESTAMP(3),
  "locked_by" TEXT,
  "last_error" TEXT,
  "result" JSONB,
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jobs_post_id_fkey"
    FOREIGN KEY ("post_id") REFERENCES "posts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "jobs_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "jobs_type_check"
    CHECK ("type" IN ('publish_post', 'publish_reply')),
  CONSTRAINT "jobs_status_check"
    CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead')),
  CONSTRAINT "jobs_attempts_check"
    CHECK ("attempts" >= 0 AND "max_attempts" > 0 AND "attempts" <= "max_attempts")
);

CREATE UNIQUE INDEX "jobs_dedupe_key_key" ON "jobs"("dedupe_key");
CREATE INDEX "jobs_status_run_at_idx" ON "jobs"("status", "run_at");
CREATE INDEX "jobs_account_id_status_run_at_idx" ON "jobs"("account_id", "status", "run_at");
CREATE INDEX "jobs_post_id_type_idx" ON "jobs"("post_id", "type");

CREATE TABLE "audit_events" (
  "id" SERIAL NOT NULL,
  "account_id" INTEGER,
  "actor_type" TEXT NOT NULL DEFAULT 'admin',
  "actor_id" TEXT,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "metadata" JSONB,
  "ip_address" TEXT,
  "user_agent" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_events_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "audit_events_account_id_created_at_idx"
  ON "audit_events"("account_id", "created_at");
CREATE INDEX "audit_events_entity_type_entity_id_idx"
  ON "audit_events"("entity_type", "entity_id");
CREATE INDEX "audit_events_action_created_at_idx"
  ON "audit_events"("action", "created_at");

CREATE TABLE "worker_heartbeats" (
  "worker_id" TEXT NOT NULL,
  "version" TEXT,
  "metadata" JSONB,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("worker_id")
);

CREATE INDEX "worker_heartbeats_last_seen_at_idx"
  ON "worker_heartbeats"("last_seen_at");
