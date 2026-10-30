// infrastructure/queue/sweep.ts
// The backstop for lost or never-enqueued auto-submit jobs (design §7.6): every
// minute, lock any attempt still IN_PROGRESS more than the save grace past its
// endsAt. Each attempt goes through autoSubmitAttempt, which re-checks the state
// in its own transaction, so the sweep and the worker can overlap safely.

import { logger } from '../logger/logger.js';
import { autoSubmitAttempt, listExpiredAttemptIds } from '../../modules/exam/index.js';
import { SAVE_GRACE_MS } from './autoSubmit.queue.js';

export const SWEEP_INTERVAL_MS = 60_000;

export async function sweepExpiredAttempts(now: Date = new Date()): Promise<number> {
  const ids = await listExpiredAttemptIds(new Date(now.getTime() - SAVE_GRACE_MS));
  let locked = 0;
  for (const id of ids) {
    try {
      if (await autoSubmitAttempt(id, now)) locked += 1;
    } catch (err) {
      logger.error('sweep could not auto-submit an attempt', { attemptId: id, message: err instanceof Error ? err.message : 'unknown' });
    }
  }
  if (locked > 0) logger.info('sweep auto-submitted attempts', { count: locked });
  return locked;
}

export function startSweep(): NodeJS.Timeout {
  const timer = setInterval(() => {
    sweepExpiredAttempts().catch((err: unknown) => {
      logger.error('sweep failed', { message: err instanceof Error ? err.message : 'unknown' });
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
