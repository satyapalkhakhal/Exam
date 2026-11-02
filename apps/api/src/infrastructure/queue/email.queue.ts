// infrastructure/queue/email.queue.ts
// The BullMQ queue behind manual candidate emails (docs/email-templates.md): one
// job per email_dispatches row, id `email-{dispatchId}`, so re-adding a job for
// the same dispatch is a no-op. Opened on first use (importing this file never
// connects to Redis); same `exam` prefix as the auto-submit queue. Three
// attempts with exponential backoff; the worker marks the row FAILED after the last.

import { Queue } from 'bullmq';
import { QUEUE_PREFIX, queueConnection } from './autoSubmit.queue.js';

export const EMAIL_QUEUE = 'exam-email';
export const EMAIL_JOB_ATTEMPTS = 3;

export interface EmailJob {
  dispatchId: string;
}

let queue: Queue<EmailJob> | undefined;

export function getEmailQueue(): Queue<EmailJob> {
  queue ??= new Queue<EmailJob>(EMAIL_QUEUE, { connection: queueConnection(), prefix: QUEUE_PREFIX });
  return queue;
}

export const emailJobId = (dispatchId: string) => `email-${dispatchId}`;

export async function enqueueEmails(dispatchIds: string[]): Promise<void> {
  await getEmailQueue().addBulk(
    dispatchIds.map((dispatchId) => ({
      name: 'sendEmail',
      data: { dispatchId },
      opts: {
        jobId: emailJobId(dispatchId),
        attempts: EMAIL_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: true,
        removeOnFail: 1_000,
      },
    })),
  );
}

export async function closeEmailQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
}
