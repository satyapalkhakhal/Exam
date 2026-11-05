// modules/exam/attemptCounts.ts
// Questions and answered questions per attempt, in one query. "Answered" means a
// saved answer with at least one word, the same count the submission receipt and
// the submission email show.

import { prisma } from '../../infrastructure/db/prisma.js';

export async function attemptCounts(attemptIds: string[]): Promise<Map<string, { questionCount: number; answeredCount: number }>> {
  if (attemptIds.length === 0) return new Map();
  const counts = await prisma.$queryRaw<{ attempt_id: string; total: bigint; answered: bigint }[]>`
    SELECT q.attempt_id::text AS attempt_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE a.word_count > 0) AS answered
    FROM attempt_questions q LEFT JOIN answers a ON a.attempt_question_id = q.id
    WHERE q.attempt_id = ANY(${attemptIds}::uuid[])
    GROUP BY q.attempt_id`;
  return new Map(counts.map((c) => [c.attempt_id, { questionCount: Number(c.total), answeredCount: Number(c.answered) }]));
}
