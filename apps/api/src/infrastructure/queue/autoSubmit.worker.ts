// infrastructure/queue/autoSubmit.worker.ts
// Runs the delayed auto-submit jobs. The job only names the attempt; whether it
// may still be locked (IN_PROGRESS and past endsAt) is decided by
// autoSubmitAttempt, so a job left behind by a reset or a manual submit is a
// harmless no-op.

import { Worker } from 'bullmq';
import { logger } from '../logger/logger.js';
import { autoSubmitAttempt } from '../../modules/exam/index.js';
import { AUTO_SUBMIT_QUEUE, QUEUE_PREFIX, queueConnection, type AutoSubmitJob } from './autoSubmit.queue.js';

export function startAutoSubmitWorker(): Worker<AutoSubmitJob> {
  const worker = new Worker<AutoSubmitJob>(
    AUTO_SUBMIT_QUEUE,
    async (job) => {
      await autoSubmitAttempt(job.data.attemptId);
    },
    { connection: queueConnection(), prefix: QUEUE_PREFIX, concurrency: 5 },
  );
  worker.on('failed', (job, err) => {
    logger.warn('auto-submit job failed', { jobId: job?.id, message: err.message });
  });
  worker.on('error', (err) => {
    logger.error('auto-submit worker error', { message: err.message });
  });
  return worker;
}
