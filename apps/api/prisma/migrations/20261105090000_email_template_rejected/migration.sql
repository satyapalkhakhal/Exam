-- The "Not selected" candidate email (docs/email-templates.md). Kept in its own
-- migration so the new enum value is committed before anything uses it.
ALTER TYPE "EmailTemplateKey" ADD VALUE 'REJECTED';
