// modules/emails/emails.schemas.ts
// Request schemas for the email routes; they live in @exam/shared so the web
// app validates with the same ones.

export {
  EmailTemplateKeyParamsSchema,
  EmailTemplateUpdateSchema,
  EmailPreviewSchema,
  EmailSendSchema,
  EmailDispatchListQuerySchema,
} from '@exam/shared';
