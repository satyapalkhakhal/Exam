-- Colleges, placement/internship and campus drives
-- (docs/superpowers/specs/2026-11-10-colleges-drives-rounds-design.md).
--
-- job profile (job_roles, now with a type) -> rounds (exam_rounds: questions,
-- duration, weights, question lock) -> drives (round x college x batch: window,
-- open switch, instructions). exam_settings is split between the round and the
-- drive and dropped. Every candidate (application) moves into a drive.
--
-- Existing data: every production candidate is from IIT Guwahati (user,
-- 2026-11-10), so each job role becomes Round 1 with one drive at IITG, batch
-- "Nov 2026". Prisma runs this file in one transaction.

-- 1. New enum, tables and nullable columns -----------------------------------
CREATE TYPE "JobProfileType" AS ENUM ('PLACEMENT', 'INTERNSHIP');

ALTER TABLE "job_roles" ADD COLUMN "type" "JobProfileType" NOT NULL DEFAULT 'PLACEMENT';

CREATE TABLE "colleges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "short_code" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "colleges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "exam_rounds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_role_id" UUID NOT NULL,
    "round_number" INTEGER NOT NULL,
    "name" TEXT,
    "duration_minutes" INTEGER NOT NULL DEFAULT 60,
    "questions_locked" BOOLEAN NOT NULL DEFAULT false,
    "weight_exam" INTEGER NOT NULL DEFAULT 70,
    "weight_x" INTEGER NOT NULL DEFAULT 10,
    "weight_xii" INTEGER NOT NULL DEFAULT 10,
    "weight_cpi" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "exam_rounds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "drives" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "round_id" UUID NOT NULL,
    "college_id" UUID NOT NULL,
    "batch" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6),
    "window_end" TIMESTAMPTZ(6),
    "is_open" BOOLEAN NOT NULL DEFAULT false,
    "instructions" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "drives_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "questions" ADD COLUMN "round_id" UUID;
ALTER TABLE "import_batches" ADD COLUMN "round_id" UUID, ADD COLUMN "drive_id" UUID;
ALTER TABLE "candidates" ADD COLUMN "drive_id" UUID, ADD COLUMN "promoted_from_id" UUID;
ALTER TABLE "ai_evaluation_runs" ADD COLUMN "drive_id" UUID;

-- BACKFILL START
-- 2. The one existing college.
INSERT INTO "colleges" ("name", "short_code", "updated_at") VALUES ('IIT Guwahati', 'IITG', CURRENT_TIMESTAMP);

-- 3. Round 1 per job role from its exam_settings (defaults when it has none).
INSERT INTO "exam_rounds" ("job_role_id", "round_number", "duration_minutes", "questions_locked",
                           "weight_exam", "weight_x", "weight_xii", "weight_cpi", "updated_at")
SELECT r."id", 1,
       COALESCE(s."duration_minutes", 60), COALESCE(s."questions_locked", false),
       COALESCE(s."weight_exam", 70), COALESCE(s."weight_x", 10), COALESCE(s."weight_xii", 10), COALESCE(s."weight_cpi", 10),
       CURRENT_TIMESTAMP
FROM "job_roles" r LEFT JOIN "exam_settings" s ON s."job_role_id" = r."id";

-- 4. One IITG drive per round, batch "Nov 2026", carrying the window/open/instructions.
INSERT INTO "drives" ("round_id", "college_id", "batch", "window_start", "window_end", "is_open", "instructions", "updated_at")
SELECT er."id", c."id", 'Nov 2026', s."window_start", s."window_end", COALESCE(s."is_open", false), COALESCE(s."instructions", ''), CURRENT_TIMESTAMP
FROM "exam_rounds" er
JOIN "colleges" c ON c."short_code" = 'IITG'
LEFT JOIN "exam_settings" s ON s."job_role_id" = er."job_role_id";

-- 5. Point everything at its job role's round 1 / drive.
UPDATE "questions" q SET "round_id" = er."id"
FROM "exam_rounds" er WHERE er."job_role_id" = q."job_role_id" AND er."round_number" = 1;

UPDATE "import_batches" b SET "round_id" = er."id"
FROM "exam_rounds" er
WHERE b."kind" = 'QUESTIONS' AND er."job_role_id" = b."job_role_id" AND er."round_number" = 1;

UPDATE "import_batches" b SET "drive_id" = d."id"
FROM "exam_rounds" er JOIN "drives" d ON d."round_id" = er."id"
WHERE b."kind" = 'CANDIDATES' AND er."job_role_id" = b."job_role_id" AND er."round_number" = 1;

UPDATE "candidates" c SET "drive_id" = d."id"
FROM "exam_rounds" er JOIN "drives" d ON d."round_id" = er."id"
WHERE er."job_role_id" = c."job_role_id" AND er."round_number" = 1;

UPDATE "ai_evaluation_runs" a SET "drive_id" = d."id"
FROM "exam_rounds" er JOIN "drives" d ON d."round_id" = er."id"
WHERE a."job_role_id" IS NOT NULL AND er."job_role_id" = a."job_role_id" AND er."round_number" = 1;
-- BACKFILL END

-- 6. Constraints on the new columns.
ALTER TABLE "questions" ALTER COLUMN "round_id" SET NOT NULL;
ALTER TABLE "candidates" ALTER COLUMN "drive_id" SET NOT NULL;

-- 7. Drop what moved: old FKs, indexes, columns and exam_settings.
ALTER TABLE "exam_settings" DROP CONSTRAINT "exam_settings_job_role_id_fkey";
ALTER TABLE "questions" DROP CONSTRAINT "questions_job_role_id_fkey";
ALTER TABLE "import_batches" DROP CONSTRAINT "import_batches_job_role_id_fkey";
ALTER TABLE "ai_evaluation_runs" DROP CONSTRAINT "ai_evaluation_runs_job_role_id_fkey";

DROP INDEX "job_roles_name_key";
DROP INDEX "questions_job_role_id_active_display_order_idx";
DROP INDEX "questions_job_role_id_normalized_text_hash_key";
DROP INDEX "import_batches_job_role_id_idx";
DROP INDEX "candidates_account_id_job_role_id_key";
DROP INDEX "ai_evaluation_runs_job_role_id_created_at_idx";

ALTER TABLE "questions" DROP COLUMN "job_role_id";
ALTER TABLE "import_batches" DROP COLUMN "job_role_id";
ALTER TABLE "ai_evaluation_runs" DROP COLUMN "job_role_id";
DROP TABLE "exam_settings";

-- 8. New indexes (Prisma-declared).
CREATE UNIQUE INDEX "exam_rounds_job_role_id_round_number_key" ON "exam_rounds"("job_role_id", "round_number");
CREATE INDEX "drives_round_id_idx" ON "drives"("round_id");
CREATE INDEX "drives_college_id_idx" ON "drives"("college_id");
CREATE INDEX "questions_round_id_active_display_order_idx" ON "questions"("round_id", "active", "display_order");
CREATE UNIQUE INDEX "questions_round_id_normalized_text_hash_key" ON "questions"("round_id", "normalized_text_hash");
CREATE INDEX "import_batches_round_id_idx" ON "import_batches"("round_id");
CREATE INDEX "import_batches_drive_id_idx" ON "import_batches"("drive_id");
CREATE INDEX "candidates_drive_id_status_idx" ON "candidates"("drive_id", "status");
CREATE INDEX "candidates_drive_id_result_idx" ON "candidates"("drive_id", "result");
CREATE INDEX "candidates_promoted_from_id_idx" ON "candidates"("promoted_from_id");
CREATE UNIQUE INDEX "candidates_account_id_drive_id_key" ON "candidates"("account_id", "drive_id");
CREATE INDEX "ai_evaluation_runs_drive_id_created_at_idx" ON "ai_evaluation_runs"("drive_id", "created_at");

-- 9. Case-insensitive uniqueness Prisma cannot declare (expression indexes).
--    Violations surface as P2002 like any unique index. Do not drop these when
--    generating future migrations.
CREATE UNIQUE INDEX "job_roles_name_type_key" ON "job_roles"(lower("name"), "type");
CREATE UNIQUE INDEX "colleges_name_key" ON "colleges"(lower("name"));
CREATE UNIQUE INDEX "colleges_short_code_key" ON "colleges"("short_code");
CREATE UNIQUE INDEX "drives_round_college_batch_key" ON "drives"("round_id", "college_id", lower("batch"));

-- 10. Foreign keys.
ALTER TABLE "exam_rounds" ADD CONSTRAINT "exam_rounds_job_role_id_fkey" FOREIGN KEY ("job_role_id") REFERENCES "job_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "drives" ADD CONSTRAINT "drives_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "exam_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "drives" ADD CONSTRAINT "drives_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "colleges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "questions" ADD CONSTRAINT "questions_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "exam_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "exam_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_drive_id_fkey" FOREIGN KEY ("drive_id") REFERENCES "drives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_drive_id_fkey" FOREIGN KEY ("drive_id") REFERENCES "drives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_promoted_from_id_fkey" FOREIGN KEY ("promoted_from_id") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_evaluation_runs" ADD CONSTRAINT "ai_evaluation_runs_drive_id_fkey" FOREIGN KEY ("drive_id") REFERENCES "drives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
