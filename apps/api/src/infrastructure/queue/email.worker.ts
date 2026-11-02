// infrastructure/queue/email.worker.ts
// Delivers the queued candidate emails. The job only names the dispatch; whether
// it may still be sent (status QUEUED) is decided by the processor, so a stale
// or duplicate job is a harmless no-op. Logs carry the dispatch id only.

import { Worker } from 'bullmq';
import { logger } from '../logger/logger.js';
import { emailDispatchProcessor } from '../../modules/emails/index.js';
import { QUEUE_PREFIX, queueConnection } from './autoSubmit.queue.js';
import { EMAIL_JOB_ATTEMPTS, EMAIL_QUEUE, type EmailJob } from './email.queue.js';

export function startEmailWorker(): Worker<EmailJob> {
  const worker = new Worker<EmailJob>(
    EMAIL_QUEUE,
    async (job) => {
      const attempts = job.opts.attempts ?? EMAIL_JOB_ATTEMPTS;
      await emailDispatchProcessor(job.data.dispatchId, { finalAttempt: job.attemptsMade + 1 >= attempts });
    },
    { connection: queueConnection(), prefix: QUEUE_PREFIX, concurrency: 3 },
  );
  worker.on('failed', (job, err) => {
    logger.warn('email job failed', { jobId: job?.id, message: err.message });
  });
  worker.on('error', (err) => {
    logger.error('email worker error', { message: err.message });
  });
  return worker;
}
