// modules/evaluation/index.ts
// Barrel: marking on the Prisma repository, with flag counts from the exam
// engine reduced to their numeric breakdown (no location detail).

import { exam, flagBreakdown } from '../exam/index.js';
import { evaluationRepository } from './evaluation.repository.js';
import { createEvaluationService } from './evaluation.service.js';

export { createEvaluationRouter } from './evaluation.routes.js';
export { createEvaluationService, LOCK_TTL_MS } from './evaluation.service.js';
export type { EvaluationService } from './evaluation.service.js';
export { toMarkingView, toSubmissionView, toCandidatePii, num } from './evaluation.mapper.js';
export { combinedTotals, percentageOf, validateMarks } from './marks.js';

export async function flagCountsFor(candidateIds: string[]): Promise<Map<string, { counts: Record<string, number>; nearbyCount: number | null }>> {
  const flags = await exam.getFlagsBatch(candidateIds);
  return new Map([...flags].map(([id, f]) => [id, { counts: flagBreakdown(f), nearbyCount: f.nearbyCount }]));
}

export const evaluation = createEvaluationService({ repo: evaluationRepository, flagCounts: flagCountsFor });
