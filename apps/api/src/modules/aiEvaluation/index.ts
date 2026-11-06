// modules/aiEvaluation/index.ts
// Barrel: the process-wide AI evaluation service on the Prisma repository, the
// real OpenAI grader (tests inject their own) and the BullMQ queue wired in.

import { enqueueAiScores, removeAiScoreJobs } from '../../infrastructure/queue/aiEval.queue.js';
import { audit } from '../audit/index.js';
import { getAiConfig } from './aiEvaluation.config.js';
import { createOpenAiGrader } from './aiEvaluation.grader.js';
import { aiEvaluationRepository } from './aiEvaluation.repository.js';
import { createAiEvaluationService } from './aiEvaluation.service.js';

export { createAiEvaluationRouter } from './aiEvaluation.routes.js';
export { createAiEvaluationService, isExamOver, toRunDto } from './aiEvaluation.service.js';
export type { AiEvaluationService, AiEvaluationRepository, AiEvaluationDeps } from './aiEvaluation.service.js';
export { AI_KEY, getAiConfig, hasAiCredentials, isAiReady, mergeAi } from './aiEvaluation.config.js';
export type { AiConfig } from './aiEvaluation.config.js';
export { AiOutputError, AiProviderError, backoffDelayMs, safeErrorText } from './aiEvaluation.errors.js';
export { buildPrompt, PROMPT_VERSION } from './aiEvaluation.prompt.js';
export type { PromptInput } from './aiEvaluation.prompt.js';
export { createOpenAiGrader, normaliseMarks } from './aiEvaluation.grader.js';
export type { AiGrader, GradeRequest, GradeResult } from './aiEvaluation.grader.js';

export const aiEvaluation = createAiEvaluationService({
  repo: aiEvaluationRepository,
  getConfig: getAiConfig,
  grader: createOpenAiGrader(getAiConfig),
  enqueue: enqueueAiScores,
  removeJobs: removeAiScoreJobs,
  audit: (entry) => audit.record(entry),
});
