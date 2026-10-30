// infrastructure/queue/autoSubmit.queue.ts
// The BullMQ delayed job that locks an attempt at endsAt + grace (design §7.6),
// so an exam ends on time even if the candidate closed the browser. Keys live
// under the `exam` prefix. The queue is opened on first use, so importing this
// file never connects to Redis. One job per attempt, id `attempt-{attemptId}`
// (BullMQ refuses a custom id with a single ':'), so a retried enqueue is a
// no-op and submit can remove it. Losing a job is harmless: the minute sweep
// catches any attempt still IN_PROGRESS past its deadline.

import { Queue } from 'bullmq';
import { env } from '../config/env.js';

export const AUTO_SUBMIT_QUEUE = 'exam-auto-submit';
export const QUEUE_PREFIX = 'exam';
/** In-flight saves are accepted until endsAt + this; the job fires after it. */
export const SAVE_GRACE_MS = 10_000;

export interface AutoSubmitJob {
  attemptId: string;
}

export const queueConnection = () => ({ url: env.REDIS_URL, maxRetriesPerRequest: null });

let queue: Queue<AutoSubmitJob> | undefined;

export function getAutoSubmitQueue(): Queue<AutoSubmitJob> {
  queue ??= new Queue<AutoSubmitJob>(AUTO_SUBMIT_QUEUE, { connection: queueConnection(), prefix: QUEUE_PREFIX });
  return queue;
}

export const autoSubmitJobId = (attemptId: string) => `attempt-${attemptId}`;

export async function enqueueAutoSubmit(attemptId: string, endsAt: Date, now: Date = new Date()): Promise<void> {
  await getAutoSubmitQueue().add(
    'autoSubmit',
    { attemptId },
    {
      jobId: autoSubmitJobId(attemptId),
      delay: Math.max(0, endsAt.getTime() + SAVE_GRACE_MS - now.getTime()),
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: 1_000,
    },
  );
}

export async function removeAutoSubmit(attemptId: string): Promise<void> {
  await getAutoSubmitQueue().remove(autoSubmitJobId(attemptId));
}

export async function closeAutoSubmitQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
}
