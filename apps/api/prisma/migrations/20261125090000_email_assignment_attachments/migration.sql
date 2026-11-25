-- Round 2 assignment email (docs/email-templates.md, 2026-11-25): a fourth template
-- that goes out with a file uploaded in the admin panel.

ALTER TYPE "EmailTemplateKey" ADD VALUE 'ASSIGNMENT';

CREATE TABLE "email_attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_attachments_uploaded_by_id_idx" ON "email_attachments"("uploaded_by_id");

ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "email_dispatches" ADD COLUMN "attachment_id" UUID;

CREATE INDEX "email_dispatches_attachment_id_idx" ON "email_dispatches"("attachment_id");

ALTER TABLE "email_dispatches" ADD CONSTRAINT "email_dispatches_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "email_attachments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
