-- AI-assisted evaluation (docs/ai-evaluation.md): runs, per-question AI scores,
-- provenance on question_evaluations, and per-role composite weights.

-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('RUNNING', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AiScoreStatus" AS ENUM ('QUEUED', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "AiConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterTable
ALTER TABLE "exam_settings" ADD COLUMN     "weight_cpi" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "weight_exam" INTEGER NOT NULL DEFAULT 70,
ADD COLUMN     "weight_x" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "weight_xii" INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "question_evaluations" ADD COLUMN     "ai_score_id" UUID;

-- CreateTable
CREATE TABLE "ai_evaluation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_role_id" UUID,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'RUNNING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_evaluation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_question_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "attempt_question_id" UUID NOT NULL,
    "status" "AiScoreStatus" NOT NULL DEFAULT 'QUEUED',
    "marks" DECIMAL(6,1),
    "max_marks" DECIMAL(6,1) NOT NULL,
    "rationale" TEXT,
    "strengths" JSONB NOT NULL DEFAULT '[]',
    "improvements" JSONB NOT NULL DEFAULT '[]',
    "confidence" "AiConfidence",
    "concerns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "model" TEXT NOT NULL DEFAULT '',
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_question_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_evaluation_runs_job_role_id_created_at_idx" ON "ai_evaluation_runs"("job_role_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_evaluation_runs_status_idx" ON "ai_evaluation_runs"("status");

-- CreateIndex
CREATE INDEX "ai_evaluation_runs_created_by_id_idx" ON "ai_evaluation_runs"("created_by_id");

-- CreateIndex
CREATE INDEX "ai_question_scores_attempt_question_id_completed_at_idx" ON "ai_question_scores"("attempt_question_id", "completed_at");

-- CreateIndex
CREATE INDEX "ai_question_scores_run_id_status_idx" ON "ai_question_scores"("run_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_question_scores_run_id_attempt_question_id_key" ON "ai_question_scores"("run_id", "attempt_question_id");

-- CreateIndex
CREATE INDEX "question_evaluations_ai_score_id_idx" ON "question_evaluations"("ai_score_id");

-- AddForeignKey
ALTER TABLE "question_evaluations" ADD CONSTRAINT "question_evaluations_ai_score_id_fkey" FOREIGN KEY ("ai_score_id") REFERENCES "ai_question_scores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_runs" ADD CONSTRAINT "ai_evaluation_runs_job_role_id_fkey" FOREIGN KEY ("job_role_id") REFERENCES "job_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_runs" ADD CONSTRAINT "ai_evaluation_runs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_question_scores" ADD CONSTRAINT "ai_question_scores_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ai_evaluation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_question_scores" ADD CONSTRAINT "ai_question_scores_attempt_question_id_fkey" FOREIGN KEY ("attempt_question_id") REFERENCES "attempt_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Composite weights must add up to 100 (the app validates too; this keeps a
-- hand edit from breaking the leaderboard).
ALTER TABLE "exam_settings" ADD CONSTRAINT "exam_settings_weights_sum_check" CHECK ("weight_exam" + "weight_x" + "weight_xii" + "weight_cpi" = 100);
