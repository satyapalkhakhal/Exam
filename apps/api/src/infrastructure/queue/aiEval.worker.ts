// infrastructure/queue/aiEval.worker.ts
// Grades the queued AI scores. The job only names the score; whether it may
// still run (score QUEUED in a RUNNING run) is decided by the processor, so a
// stale or duplicate job is a no-op. Concurrency is read from the Integrations
// config when the worker starts: a change to it applies after an API restart.
// Backoff is exponential and never sooner than the provider's 429 retry-after.
// Logs carry the score id and a safe message only.

import { Worker } from 'bullmq';
import { logger } from '../logger/logger.js';
import { aiEvaluation, backoffDelayMs, getAiConfig } from '../../modules/aiEvaluation/index.js';
import { QUEUE_PREFIX, queueConnection } from './autoSubmit.queue.js';
import { AI_EVAL_JOB_ATTEMPTS, AI_EVAL_QUEUE, type AiEvalJob } from './aiEval.queue.js';

const FALLBACK_CONCURRENCY = 3;

export async function startAiEvalWorker(): Promise<Worker<AiEvalJob>> {
  const concurrency = await getAiConfig()
    .then((c) => c.concurrency)
    .catch(() => FALLBACK_CONCURRENCY);
  const worker = new Worker<AiEvalJob>(
    AI_EVAL_QUEUE,
    async (job) => {
      const attempts = job.opts.attempts ?? AI_EVAL_JOB_ATTEMPTS;
      await aiEvaluation.processScore(job.data.scoreId, { finalAttempt: job.attemptsMade + 1 >= attempts });
    },
    {
      connection: queueConnection(),
      prefix: QUEUE_PREFIX,
      concurrency,
      settings: { backoffStrategy: (attemptsMade, _type, err) => backoffDelayMs(attemptsMade, err) },
    },
  );
  worker.on('failed', (job, err) => {
    logger.warn('ai evaluation job failed', { jobId: job?.id, message: err.name === 'AiOutputError' || err.name === 'AiProviderError' ? err.message : 'unexpected error' });
  });
  worker.on('error', (err) => {
    logger.error('ai evaluation worker error', { message: err.message });
  });
  return worker;
}
