// infrastructure/queue/aiEval.worker.ts
// Grades the queued AI scores. The job only names the score; whether it may
// still run (score QUEUED in a RUNNING run) is decided by the processor, so a
// stale or duplicate job is a no-op. Concurrency comes from the Integrations
// config and is re-read every CONCURRENCY_POLL_MS, so a change applies without a restart.
// Backoff is exponential and never sooner than the provider's 429 retry-after.
// Logs carry the score id and a safe message only.

import { Worker } from 'bullmq';
import { logger } from '../logger/logger.js';
import { aiEvaluation, backoffDelayMs, getAiConfig } from '../../modules/aiEvaluation/index.js';
import { QUEUE_PREFIX, queueConnection } from './autoSubmit.queue.js';
import { AI_EVAL_JOB_ATTEMPTS, AI_EVAL_QUEUE, type AiEvalJob } from './aiEval.queue.js';

const FALLBACK_CONCURRENCY = 3;
const CONCURRENCY_POLL_MS = 30_000;

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
  const poll = setInterval(() => {
    getAiConfig()
      .then((c) => {
        if (c.concurrency !== worker.concurrency) {
          logger.info('ai evaluation concurrency changed', { from: worker.concurrency, to: c.concurrency });
          worker.concurrency = c.concurrency;
        }
      })
      .catch(() => undefined);
  }, CONCURRENCY_POLL_MS);
  poll.unref();
  worker.on('closed', () => clearInterval(poll));
  return worker;
}
