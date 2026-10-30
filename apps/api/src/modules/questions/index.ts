// modules/questions/index.ts
// Barrel: questions, their lock and the spreadsheet import on the Prisma
// repository. Candidates never read this module; they see AttemptQuestion snapshots.

import { getRedis } from '../../infrastructure/redis/redis.js';
import { questionsRepository } from './questions.repository.js';
import { createQuestionsService } from './questions.service.js';

export { createQuestionsRouter, createRoleQuestionsRouter } from './questions.routes.js';
export { createQuestionsService } from './questions.service.js';
export type { QuestionsService, QuestionsRepository } from './questions.service.js';
export { questionsRepository, withRoleSettingsLock, lockRoleSettings } from './questions.repository.js';

export const questions = createQuestionsService(questionsRepository, { redis: getRedis });
