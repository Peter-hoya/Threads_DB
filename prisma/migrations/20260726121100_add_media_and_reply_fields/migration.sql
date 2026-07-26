-- DropIndex
DROP INDEX IF EXISTS "posts_status_scheduled_at_idx";

-- AlterTable
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "media_type" TEXT;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "media_url" TEXT;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "reply_content" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "posts_status_id_idx" ON "posts"("status", "id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "posts_platform_status_idx" ON "posts"("platform", "status");
