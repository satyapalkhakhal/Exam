// modules/exam/index.ts
// Barrel: the exam engine wired to Prisma, the role settings, the candidate
// location capture, the auto-submit queue and the beacon family binding.
// `exam.getFlags` / `getFlagsBatch` / `getFlagCounts` (scored by flagScore)
// are the review-flag views other modules (candidates list, evaluation) consume; autoSubmitAttempt and
// listExpiredAttemptIds serve the BullMQ worker and the minute sweep.

import { candidateAuthService } from '../candidateAuth/index.js';
import { jobRoles } from '../jobRoles/index.js';
import { enqueueAutoSubmit, removeAutoSubmit } from '../../infrastructure/queue/autoSubmit.queue.js';
import { examRepository } from './exam.repository.js';
import { createExamService } from './exam.service.js';
import { bindExamFamily, resolveExamFamily } from './sessionBinding.js';

export { createExamRouter } from './exam.routes.js';
export { createExamService } from './exam.service.js';
export type { ExamService, IntegrityCounts } from './exam.service.js';
export type { LocationFlag } from './locationFlags.js';
export { assessSave } from './integrity.js';

export const examService = createExamService({
  repo: examRepository,
  getSettings: (jobRoleId) => jobRoles.getSettings(jobRoleId),
  recordStartLocation: async (auth, applicationId, location, client) => {
    await candidateAuthService.recordLocation(
      auth,
      {
        stage: 'EXAM_START',
        permission: location.permission,
        ...(location.latitude !== undefined ? { latitude: location.latitude } : {}),
        ...(location.longitude !== undefined ? { longitude: location.longitude } : {}),
        ...(location.accuracyM !== undefined ? { accuracyM: location.accuracyM } : {}),
      },
      client,
      applicationId,
    );
  },
  queue: { enqueue: (id, endsAt) => enqueueAutoSubmit(id, endsAt), remove: removeAutoSubmit },
  bindFamily: bindExamFamily,
});

export const examAuth = { isActive: candidateAuthService.isActive, resolveFamily: resolveExamFamily };
export const ownsApplication = examRepository.ownsApplication;

export { flagBreakdown, flagScore, TAB_HIDDEN_THRESHOLD } from './flagScore.js';
export type { CandidateFlags, FlagBreakdown } from './flagScore.js';

export const exam = {
  getFlags: examService.getFlags,
  getFlagsBatch: examService.getFlagsBatch,
  computeLocationFlags: examService.computeLocationFlags,
};
export const getFlagCounts = examService.getFlagCounts;
export const autoSubmitAttempt = examService.autoSubmitAttempt;
export const listExpiredAttemptIds = examService.listExpiredAttemptIds;
