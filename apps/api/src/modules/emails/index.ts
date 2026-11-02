// modules/emails/index.ts
// Barrel: the process-wide emails service and dispatch processor on the Prisma
// repository, with audit, messaging and the BullMQ queue wired in.

import crypto from 'node:crypto';
import { enqueueEmails } from '../../infrastructure/queue/email.queue.js';
import { audit } from '../audit/index.js';
import { getEmailConfig, isChannelReady, sendEmail } from '../messaging/index.js';
import { systemConfig } from '../systemConfig/index.js';
import { emailsRepository } from './emails.repository.js';
import { createDispatchProcessor, createEmailsService } from './emails.service.js';

export { createEmailTemplatesRouter, createEmailsRouter } from './emails.routes.js';
export { createEmailsService, createDispatchProcessor } from './emails.service.js';
export type { EmailsService, EmailsRepository, EmailsDeps, DispatchRepository } from './emails.service.js';
export { emailsRepository };

export const emails = createEmailsService({
  repo: emailsRepository,
  config: systemConfig,
  audit: (entry) => audit.record(entry),
  getEmailConfig,
  isChannelReady,
  sendEmail,
  enqueue: enqueueEmails,
  newBatchId: () => crypto.randomUUID(),
});

export const emailDispatchProcessor = createDispatchProcessor({ repo: emailsRepository, sendEmail });
