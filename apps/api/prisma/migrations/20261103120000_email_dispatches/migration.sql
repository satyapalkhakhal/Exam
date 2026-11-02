-- Manual candidate emails (docs/email-templates.md): one row per queued email,
-- with the rendered content kept so the record shows exactly what was sent.

-- CreateEnum
CREATE TYPE "EmailTemplateKey" AS ENUM ('SUBMISSION_RECEIVED', 'SHORTLISTED');

-- CreateEnum
CREATE TYPE "EmailDispatchStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "email_dispatches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batch_id" UUID NOT NULL,
    "template" "EmailTemplateKey" NOT NULL,
    "candidate_id" UUID NOT NULL,
    "to_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "EmailDispatchStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "email_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_dispatches_candidate_id_template_idx" ON "email_dispatches"("candidate_id", "template");

-- CreateIndex
CREATE INDEX "email_dispatches_batch_id_idx" ON "email_dispatches"("batch_id");

-- CreateIndex
CREATE INDEX "email_dispatches_status_idx" ON "email_dispatches"("status");

-- CreateIndex
CREATE INDEX "email_dispatches_sent_by_id_idx" ON "email_dispatches"("sent_by_id");

-- CreateIndex
CREATE INDEX "email_dispatches_created_at_idx" ON "email_dispatches"("created_at");

-- AddForeignKey
ALTER TABLE "email_dispatches" ADD CONSTRAINT "email_dispatches_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_dispatches" ADD CONSTRAINT "email_dispatches_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
