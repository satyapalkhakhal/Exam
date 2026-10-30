-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'EVALUATOR');

-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('CANDIDATES', 'QUESTIONS');

-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED', 'SHORTLISTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED', 'RESET');

-- CreateEnum
CREATE TYPE "SubmitType" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "LoginStage" AS ENUM ('LOGIN', 'EXAM_START');

-- CreateEnum
CREATE TYPE "LocationPermission" AS ENUM ('GRANTED', 'DENIED', 'UNAVAILABLE', 'TIMEOUT', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "EvaluationStatus" AS ENUM ('DRAFT', 'SUBMITTED');

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "ref_applicant_count" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "job_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_role_id" UUID NOT NULL,
    "duration_minutes" INTEGER NOT NULL DEFAULT 60,
    "window_start" TIMESTAMPTZ(6),
    "window_end" TIMESTAMPTZ(6),
    "instructions" TEXT NOT NULL DEFAULT '',
    "is_open" BOOLEAN NOT NULL DEFAULT false,
    "questions_locked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exam_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_role_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "normalized_text_hash" TEXT NOT NULL,
    "max_marks" DECIMAL(6,1) NOT NULL,
    "evaluator_guidance" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "ImportKind" NOT NULL,
    "job_role_id" UUID,
    "file_name" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "candidate_code" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "mobile" TEXT,
    "roll_number" TEXT,
    "x_percentage" DECIMAL(5,2),
    "xii_percentage" DECIMAL(5,2),
    "major_cpi" DECIMAL(5,2),
    "discipline" TEXT,
    "programme" TEXT,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "job_role_id" UUID NOT NULL,
    "eligible" BOOLEAN NOT NULL DEFAULT true,
    "location_exempt" BOOLEAN NOT NULL DEFAULT false,
    "status" "CandidateStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "import_batch_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "candidate_id" UUID NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "submit_type" "SubmitType",
    "active_session_id" TEXT NOT NULL,
    "start_ip" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL,
    "total_marks" DECIMAL(7,1),
    "max_marks" DECIMAL(7,1) NOT NULL,
    "percentage" DECIMAL(5,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exam_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempt_questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attempt_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "text_snapshot" TEXT NOT NULL,
    "max_marks_snapshot" DECIMAL(6,1) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attempt_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attempt_question_id" UUID NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "word_count" INTEGER NOT NULL DEFAULT 0,
    "client_seq" INTEGER NOT NULL DEFAULT 0,
    "last_saved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "marked_for_review" BOOLEAN NOT NULL DEFAULT false,
    "visited" BOOLEAN NOT NULL DEFAULT false,
    "bulk_insert_flags" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answer_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "answer_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "word_count" INTEGER NOT NULL,
    "saved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "answer_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "candidate_id" UUID NOT NULL,
    "attempt_id" UUID,
    "event_type" TEXT NOT NULL,
    "question_id" UUID,
    "ip" TEXT NOT NULL,
    "session_id" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_login_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "candidate_id" UUID NOT NULL,
    "stage" "LoginStage" NOT NULL,
    "permission" "LocationPermission" NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "accuracy_m" INTEGER,
    "ip" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "device_type" TEXT NOT NULL,
    "session_family" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_login_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_evaluations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attempt_question_id" UUID NOT NULL,
    "marks" DECIMAL(6,1) NOT NULL,
    "comment" TEXT,
    "evaluator_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "question_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempt_evaluations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attempt_id" UUID NOT NULL,
    "status" "EvaluationStatus" NOT NULL DEFAULT 'DRAFT',
    "evaluator_id" UUID,
    "locked_by_id" UUID,
    "locked_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attempt_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "candidate_id" UUID NOT NULL,
    "from_status" "CandidateStatus",
    "to_status" "CandidateStatus" NOT NULL,
    "by_admin_id" UUID,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "is_secret" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "system_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_id" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "job_roles_name_key" ON "job_roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "exam_settings_job_role_id_key" ON "exam_settings"("job_role_id");

-- CreateIndex
CREATE INDEX "questions_job_role_id_active_display_order_idx" ON "questions"("job_role_id", "active", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "questions_job_role_id_normalized_text_hash_key" ON "questions"("job_role_id", "normalized_text_hash");

-- CreateIndex
CREATE INDEX "import_batches_kind_created_at_idx" ON "import_batches"("kind", "created_at");

-- CreateIndex
CREATE INDEX "import_batches_file_hash_idx" ON "import_batches"("file_hash");

-- CreateIndex
CREATE INDEX "import_batches_uploaded_by_id_idx" ON "import_batches"("uploaded_by_id");

-- CreateIndex
CREATE INDEX "import_batches_job_role_id_idx" ON "import_batches"("job_role_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_candidate_code_key" ON "candidates"("candidate_code");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_email_key" ON "candidates"("email");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_mobile_key" ON "candidates"("mobile");

-- CreateIndex
CREATE INDEX "candidates_job_role_id_status_idx" ON "candidates"("job_role_id", "status");

-- CreateIndex
CREATE INDEX "candidates_import_batch_id_idx" ON "candidates"("import_batch_id");

-- CreateIndex
CREATE INDEX "candidates_roll_number_idx" ON "candidates"("roll_number");

-- CreateIndex
CREATE INDEX "exam_attempts_candidate_id_idx" ON "exam_attempts"("candidate_id");

-- CreateIndex
CREATE INDEX "exam_attempts_status_ends_at_idx" ON "exam_attempts"("status", "ends_at");

-- CreateIndex
CREATE INDEX "attempt_questions_attempt_id_order_idx" ON "attempt_questions"("attempt_id", "order");

-- CreateIndex
CREATE INDEX "attempt_questions_question_id_idx" ON "attempt_questions"("question_id");

-- CreateIndex
CREATE UNIQUE INDEX "attempt_questions_attempt_id_question_id_key" ON "attempt_questions"("attempt_id", "question_id");

-- CreateIndex
CREATE UNIQUE INDEX "answers_attempt_question_id_key" ON "answers"("attempt_question_id");

-- CreateIndex
CREATE INDEX "answer_versions_answer_id_saved_at_idx" ON "answer_versions"("answer_id", "saved_at");

-- CreateIndex
CREATE INDEX "activity_logs_attempt_id_created_at_idx" ON "activity_logs"("attempt_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_logs_candidate_id_created_at_idx" ON "activity_logs"("candidate_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_logs_event_type_idx" ON "activity_logs"("event_type");

-- CreateIndex
CREATE INDEX "candidate_login_logs_candidate_id_created_at_idx" ON "candidate_login_logs"("candidate_id", "created_at");

-- CreateIndex
CREATE INDEX "candidate_login_logs_ip_idx" ON "candidate_login_logs"("ip");

-- CreateIndex
CREATE UNIQUE INDEX "question_evaluations_attempt_question_id_key" ON "question_evaluations"("attempt_question_id");

-- CreateIndex
CREATE INDEX "question_evaluations_evaluator_id_idx" ON "question_evaluations"("evaluator_id");

-- CreateIndex
CREATE UNIQUE INDEX "attempt_evaluations_attempt_id_key" ON "attempt_evaluations"("attempt_id");

-- CreateIndex
CREATE INDEX "attempt_evaluations_status_idx" ON "attempt_evaluations"("status");

-- CreateIndex
CREATE INDEX "attempt_evaluations_evaluator_id_idx" ON "attempt_evaluations"("evaluator_id");

-- CreateIndex
CREATE INDEX "attempt_evaluations_locked_by_id_idx" ON "attempt_evaluations"("locked_by_id");

-- CreateIndex
CREATE INDEX "candidate_status_history_candidate_id_created_at_idx" ON "candidate_status_history"("candidate_id", "created_at");

-- CreateIndex
CREATE INDEX "candidate_status_history_by_admin_id_idx" ON "candidate_status_history"("by_admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "system_configs_key_key" ON "system_configs"("key");

-- CreateIndex
CREATE INDEX "system_configs_updated_by_id_idx" ON "system_configs"("updated_by_id");

-- CreateIndex
CREATE INDEX "admin_audit_logs_admin_id_created_at_idx" ON "admin_audit_logs"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_logs_entity_entity_id_idx" ON "admin_audit_logs"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "exam_settings" ADD CONSTRAINT "exam_settings_job_role_id_fkey" FOREIGN KEY ("job_role_id") REFERENCES "job_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_job_role_id_fkey" FOREIGN KEY ("job_role_id") REFERENCES "job_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_job_role_id_fkey" FOREIGN KEY ("job_role_id") REFERENCES "job_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_job_role_id_fkey" FOREIGN KEY ("job_role_id") REFERENCES "job_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "exam_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_attempt_question_id_fkey" FOREIGN KEY ("attempt_question_id") REFERENCES "attempt_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_versions" ADD CONSTRAINT "answer_versions_answer_id_fkey" FOREIGN KEY ("answer_id") REFERENCES "answers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "exam_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_login_logs" ADD CONSTRAINT "candidate_login_logs_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_evaluations" ADD CONSTRAINT "question_evaluations_attempt_question_id_fkey" FOREIGN KEY ("attempt_question_id") REFERENCES "attempt_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_evaluations" ADD CONSTRAINT "question_evaluations_evaluator_id_fkey" FOREIGN KEY ("evaluator_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_evaluations" ADD CONSTRAINT "attempt_evaluations_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "exam_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_evaluations" ADD CONSTRAINT "attempt_evaluations_evaluator_id_fkey" FOREIGN KEY ("evaluator_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_evaluations" ADD CONSTRAINT "attempt_evaluations_locked_by_id_fkey" FOREIGN KEY ("locked_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_status_history" ADD CONSTRAINT "candidate_status_history_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_status_history" ADD CONSTRAINT "candidate_status_history_by_admin_id_fkey" FOREIGN KEY ("by_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_configs" ADD CONSTRAINT "system_configs_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One live attempt per candidate: a reset moves the old row to RESET and keeps
-- it, so uniqueness applies only to non-RESET rows. Prisma cannot model this.
CREATE UNIQUE INDEX "uq_exam_attempts_candidate_active" ON "exam_attempts"("candidate_id") WHERE "status" <> 'RESET';
