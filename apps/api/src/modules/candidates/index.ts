// modules/candidates/index.ts
// Barrel: candidate import and management on the Prisma repository. Disabling a
// candidate or resetting an attempt revokes their sessions. flagCount and the
// detail's flags come from the exam module.

import { getRedis } from '../../infrastructure/redis/redis.js';
import { revokeAllSessions } from '../adminAuth/index.js';
import { exam, flagScore, getFlagCounts } from '../exam/index.js';
import { candidatesRepository } from './candidates.repository.js';
import { createCandidatesService } from './candidates.service.js';

export { createCandidatesRouter } from './candidates.routes.js';
export { createCandidatesService } from './candidates.service.js';
export type { CandidatesService, CandidatesRepository } from './candidates.service.js';
export { candidatesRepository };

export const candidates = createCandidatesService(candidatesRepository, {
  redis: getRedis,
  revokeSessions: (id) => revokeAllSessions('candidate', id),
  flagCounts: getFlagCounts,
  getFlags: exam.getFlags,
  flagScore,
});
