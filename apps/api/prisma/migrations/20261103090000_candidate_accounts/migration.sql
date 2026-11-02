-- Multiple exams per candidate (docs/multi-exam.md): a person signs in through a
-- candidate account and may hold one application (candidates row) per job role.
-- Email and mobile were unique on candidates, so the backfill is 1:1.
-- Each backfilled account reuses its candidate's id, so access tokens, refresh
-- tokens and session-valid-after keys issued before the migration (all keyed by
-- candidate id) keep resolving to the same person.
-- The partial unique index uq_exam_attempts_candidate_active is untouched.

-- CreateTable
CREATE TABLE "candidate_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "mobile" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "candidate_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "candidate_accounts_email_key" ON "candidate_accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_accounts_mobile_key" ON "candidate_accounts"("mobile");

-- Backfill: one account per existing candidate.
INSERT INTO "candidate_accounts" ("id", "email", "mobile", "created_at", "updated_at")
SELECT "id", "email", "mobile", "created_at", CURRENT_TIMESTAMP FROM "candidates";

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN "account_id" UUID;

UPDATE "candidates" SET "account_id" = "id";

ALTER TABLE "candidates" ALTER COLUMN "account_id" SET NOT NULL;

-- Email and mobile are copies of the account's now; uniqueness moves to the account.
DROP INDEX "candidates_email_key";
DROP INDEX "candidates_mobile_key";

-- CreateIndex
CREATE INDEX "candidates_email_idx" ON "candidates"("email");

-- CreateIndex
CREATE INDEX "candidates_mobile_idx" ON "candidates"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_account_id_job_role_id_key" ON "candidates"("account_id", "job_role_id");

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "candidate_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
