// infrastructure/queue/aiEval.queue.ts
// The BullMQ queue behind AI-assisted grading (docs/ai-evaluation.md §5): one
// job per ai_question_scores row, id `ai-{scoreId}`, so re-adding the same score
// is a no-op and a cancel can remove the waiting jobs. Opened on first use
// (importing this file never connects to Redis); same `exam` prefix as the other
// queues. Four attempts; the worker's custom backoff is exponential and honours
// a 429 retry-after. Failed jobs are kept (capped) for inspection; they hold
// only the score id.

import { Queue } from 'bullmq';
import { QUEUE_PREFIX, queueConnection } from './autoSubmit.queue.js';

export const AI_EVAL_QUEUE = 'exam-ai-eval';
export const AI_EVAL_JOB_ATTEMPTS = 4;

export interface AiEvalJob {
  scoreId: string;
}

let queue: Queue<AiEvalJob> | undefined;

export function getAiEvalQueue(): Queue<AiEvalJob> {
  queue ??= new Queue<AiEvalJob>(AI_EVAL_QUEUE, { connection: queueConnection(), prefix: QUEUE_PREFIX });
  return queue;
}

export const aiEvalJobId = (scoreId: string) => `ai-${scoreId}`;

export async function enqueueAiScores(scoreIds: string[]): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < scoreIds.length; i += CHUNK) {
    await getAiEvalQueue().addBulk(
      scoreIds.slice(i, i + CHUNK).map((scoreId) => ({
        name: 'gradeQuestion',
        data: { scoreId },
        opts: {
          jobId: aiEvalJobId(scoreId),
          attempts: AI_EVAL_JOB_ATTEMPTS,
          backoff: { type: 'custom' },
          removeOnComplete: true,
          removeOnFail: 1_000,
        },
      })),
    );
  }
}

/** Removes waiting jobs for cancelled scores; one already running finishes and is ignored. */
export async function removeAiScoreJobs(scoreIds: string[]): Promise<void> {
  const q = getAiEvalQueue();
  await Promise.allSettled(scoreIds.map(async (id) => (await q.getJob(aiEvalJobId(id)))?.remove()));
}

export async function closeAiEvalQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
}
