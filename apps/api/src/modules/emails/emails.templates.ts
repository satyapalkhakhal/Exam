// modules/emails/emails.templates.ts
// Display metadata for the two editable templates: names, descriptions and what
// each placeholder means. The default subject/body text lives with the builders
// in modules/messaging/candidateEmails.ts.

import { EMAIL_TEMPLATE_PLACEHOLDERS, type EmailTemplateKey } from '@exam/shared';

export const EMAIL_TEMPLATE_META: Record<EmailTemplateKey, { name: string; description: string }> = {
  SUBMISSION_RECEIVED: {
    name: 'Submission received',
    description: 'Confirms to a candidate that their exam was received. Sent manually, once the exam is submitted.',
  },
  SHORTLISTED: {
    name: 'Shortlisted for next round',
    description: 'Tells a shortlisted candidate they qualified for the next round. Sent manually, with the next-round details.',
  },
};

const PLACEHOLDER_DESCRIPTIONS: Record<string, string> = {
  firstName: "Candidate's first name",
  fullName: "Candidate's full name",
  role: 'Job role applied for',
  candidateCode: 'Candidate code',
  contactEmail: 'HR contact email',
  submittedAt: 'When the exam was submitted (IST)',
  answeredCount: 'Questions answered',
  questionCount: 'Total questions',
  roundName: 'Name of the next round (or "next round")',
  scheduledAt: 'Date and time of the next round (IST)',
  confirmBy: 'Confirmation deadline (IST)',
};

export const placeholderDocs = (key: EmailTemplateKey): { token: string; description: string }[] =>
  EMAIL_TEMPLATE_PLACEHOLDERS[key].map((token) => ({ token: `{${token}}`, description: PLACEHOLDER_DESCRIPTIONS[token] ?? token }));
