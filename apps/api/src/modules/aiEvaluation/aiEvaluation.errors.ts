// modules/aiEvaluation/aiEvaluation.errors.ts
// Errors the grader raises. Messages are fixed, safe strings: they are stored on
// the score row and shown to admins, so they never carry provider text (which
// can echo key fragments) or any answer content.

/** The model's reply did not satisfy the output schema (counts as a failed attempt, retried). */
export class AiOutputError extends Error {
  constructor(message = 'The model returned an invalid response') {
    super(message);
    this.name = 'AiOutputError';
  }
}

/** The provider call failed. `retryAfterMs` carries a 429 retry-after hint when given. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** The text stored in ai_question_scores.error: a short, safe reason. */
export function safeErrorText(err: unknown): string {
  if (err instanceof AiOutputError || err instanceof AiProviderError) return err.message.slice(0, 200);
  return 'Grading failed';
}

const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * BullMQ custom backoff: exponential, but never sooner than the provider's
 * retry-after on a 429. attemptsMade starts at 1 for the first failure.
 */
export function backoffDelayMs(attemptsMade: number, err?: Error): number {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attemptsMade - 1));
  const hint = err instanceof AiProviderError && err.retryAfterMs ? err.retryAfterMs : 0;
  return Math.min(MAX_BACKOFF_MS, Math.max(exp, hint));
}
