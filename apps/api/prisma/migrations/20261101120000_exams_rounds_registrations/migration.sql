-- Job profile -> exams -> rounds, with candidates registered per exam.
--
-- Exam settings and questions move from the job profile down to an exam round;
-- a person's place in an exam becomes an exam_registration and their place in
-- one round a round_entry, which attempts and status history now hang off.
-- Existing data is carried over (see BACKFILL): each job profile becomes one
-- exam named after it with a Round 1 holding its exam_settings and questions,
-- and each candidate is registered for that exam with one Round 1 entry.
--
-- The only non-additive steps remove constraints, not data: the old
-- one-attempt-per-candidate index and the per-profile question uniqueness both
-- block the feature, and questions/candidates.job_role_id become nullable.
-- exam_settings, questions.job_role_id and candidates.job_role_id/status are
-- kept (no longer read or written) for a later cleanup release.

-- CreateTable
CREATE TABLE "exams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_role_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_rounds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_id" UUID NOT NULL,
    "round_number" INTEGER NOT NULL,
    "name" TEXT,
    "duration_minutes" INTEGER NOT NULL DEFAULT 60,
    "window_start" TIMESTAMPTZ(6),
    "window_end" TIMESTAMPTZ(6),
    "instructions" TEXT NOT NULL DEFAULT '',
    "is_open" BOOLEAN NOT NULL DEFAULT false,
    "questions_locked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exam_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_registrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "candidate_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "import_batch_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "registration_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "status" "CandidateStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "round_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exams_name_key" ON "exams"("name");

-- CreateIndex
CREATE INDEX "exams_job_role_id_idx" ON "exams"("job_role_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_rounds_exam_id_round_number_key" ON "exam_rounds"("exam_id", "round_number");

-- CreateIndex
CREATE INDEX "exam_registrations_exam_id_idx" ON "exam_registrations"("exam_id");

-- CreateIndex
CREATE INDEX "exam_registrations_import_batch_id_idx" ON "exam_registrations"("import_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_registrations_candidate_id_exam_id_key" ON "exam_registrations"("candidate_id", "exam_id");

-- CreateIndex
CREATE INDEX "round_entries_round_id_status_idx" ON "round_entries"("round_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "round_entries_registration_id_round_id_key" ON "round_entries"("registration_id", "round_id");

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_job_role_id_fkey" FOREIGN KEY ("job_role_id") REFERENCES "job_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_rounds" ADD CONSTRAINT "exam_rounds_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_registrations" ADD CONSTRAINT "exam_registrations_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_registrations" ADD CONSTRAINT "exam_registrations_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_registrations" ADD CONSTRAINT "exam_registrations_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "exam_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "exam_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: link columns, nullable until the backfill has filled them.
ALTER TABLE "questions" ADD COLUMN "round_id" UUID;

-- AlterTable
ALTER TABLE "exam_attempts" ADD COLUMN "round_entry_id" UUID;

-- AlterTable
ALTER TABLE "candidate_status_history" ADD COLUMN "round_entry_id" UUID;

-- AlterTable
ALTER TABLE "import_batches" ADD COLUMN "exam_id" UUID;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "exam_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_round_entry_id_fkey" FOREIGN KEY ("round_entry_id") REFERENCES "round_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_status_history" ADD CONSTRAINT "candidate_status_history_round_entry_id_fkey" FOREIGN KEY ("round_entry_id") REFERENCES "round_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- BACKFILL
-- Today every candidate, question and exam_settings row belongs to exactly one
-- job profile, so each profile maps to exactly one exam and one Round 1 and
-- each candidate to exactly one registration and one round entry.

-- 1. One exam per job profile, named exactly as the profile (job_roles.name is
--    unique, so exams.name stays unique), active as the profile is.
INSERT INTO "exams" ("job_role_id", "name", "active", "created_at", "updated_at")
SELECT j."id", j."name", j."active", j."created_at", CURRENT_TIMESTAMP
FROM "job_roles" j;

--    ...and its Round 1 with the profile's exam_settings; a profile without an
--    exam_settings row gets the column defaults.
INSERT INTO "exam_rounds" ("exam_id", "round_number", "duration_minutes", "window_start", "window_end",
                           "instructions", "is_open", "questions_locked", "created_at", "updated_at")
SELECT e."id", 1,
       COALESCE(s."duration_minutes", 60), s."window_start", s."window_end",
       COALESCE(s."instructions", ''), COALESCE(s."is_open", false), COALESCE(s."questions_locked", false),
       COALESCE(s."created_at", e."created_at"), CURRENT_TIMESTAMP
FROM "exams" e
LEFT JOIN "exam_settings" s ON s."job_role_id" = e."job_role_id";

-- 2. Every question moves to its profile's Round 1.
UPDATE "questions" q
SET "round_id" = r."id"
FROM "exams" e
JOIN "exam_rounds" r ON r."exam_id" = e."id" AND r."round_number" = 1
WHERE e."job_role_id" = q."job_role_id";

-- 3. Every candidate is registered once for their profile's exam (keeping the
--    import batch) with one Round 1 entry carrying their current status.
INSERT INTO "exam_registrations" ("candidate_id", "exam_id", "import_batch_id", "created_at")
SELECT c."id", e."id", c."import_batch_id", c."created_at"
FROM "candidates" c
JOIN "exams" e ON e."job_role_id" = c."job_role_id";

INSERT INTO "round_entries" ("registration_id", "round_id", "status", "created_at", "updated_at")
SELECT reg."id", r."id", c."status", c."created_at", CURRENT_TIMESTAMP
FROM "exam_registrations" reg
JOIN "candidates" c ON c."id" = reg."candidate_id"
JOIN "exam_rounds" r ON r."exam_id" = reg."exam_id" AND r."round_number" = 1;

-- 4. Every attempt (RESET ones included) and every status-history row goes to
--    the candidate's single round entry.
UPDATE "exam_attempts" a
SET "round_entry_id" = re."id"
FROM "exam_registrations" reg
JOIN "round_entries" re ON re."registration_id" = reg."id"
WHERE reg."candidate_id" = a."candidate_id";

UPDATE "candidate_status_history" h
SET "round_entry_id" = re."id"
FROM "exam_registrations" reg
JOIN "round_entries" re ON re."registration_id" = reg."id"
WHERE reg."candidate_id" = h."candidate_id";

-- END BACKFILL
-- The SET NOT NULLs below fail the migration if any row was left unlinked.

-- AlterTable
ALTER TABLE "exam_attempts" ALTER COLUMN "round_entry_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "candidate_status_history" ALTER COLUMN "round_entry_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "questions" ALTER COLUMN "round_id" SET NOT NULL;

-- One live attempt per round entry (a reset keeps the old row as RESET) and
-- one exam at a time per person replace one live attempt per candidate.
-- Prisma cannot model these partial indexes.
DROP INDEX "uq_exam_attempts_candidate_active";

CREATE UNIQUE INDEX "uq_exam_attempts_entry_live" ON "exam_attempts"("round_entry_id") WHERE "status" <> 'RESET';

CREATE UNIQUE INDEX "uq_exam_attempts_candidate_in_progress" ON "exam_attempts"("candidate_id") WHERE "status" = 'IN_PROGRESS';

-- DropIndex: the same question may now sit in two rounds of one profile.
DROP INDEX "questions_job_role_id_normalized_text_hash_key";

-- CreateIndex
CREATE UNIQUE INDEX "questions_round_id_normalized_text_hash_key" ON "questions"("round_id", "normalized_text_hash");

-- CreateIndex
CREATE INDEX "questions_round_id_active_display_order_idx" ON "questions"("round_id", "active", "display_order");

-- CreateIndex
CREATE INDEX "exam_attempts_round_entry_id_idx" ON "exam_attempts"("round_entry_id");

-- CreateIndex
CREATE INDEX "candidate_status_history_round_entry_id_created_at_idx" ON "candidate_status_history"("round_entry_id", "created_at");

-- CreateIndex
CREATE INDEX "import_batches_exam_id_idx" ON "import_batches"("exam_id");

-- AlterTable: job_role_id is no longer read or written on these tables.
ALTER TABLE "questions" ALTER COLUMN "job_role_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "candidates" ALTER COLUMN "job_role_id" DROP NOT NULL;
