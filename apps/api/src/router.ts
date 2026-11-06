// router.ts
// Mounted under /api. Admin areas other than /auth are gated here, at the
// mount, by authenticateAdmin + authorize, so no Super Admin router can be
// mounted without its role check. The results router is mounted last at
// /admin and gates each route itself (the dashboard is open to evaluators).

import { Router } from 'express';
import { adminAuthService, createAdminAuthRouter } from './modules/adminAuth/index.js';
import { adminUsersService, createAdminUsersRouter } from './modules/adminUsers/index.js';
import { createJobRolesRouter, jobRoles } from './modules/jobRoles/index.js';
import { createQuestionsRouter, createRoleQuestionsRouter, questions } from './modules/questions/index.js';
import { candidates, createCandidatesRouter } from './modules/candidates/index.js';
import { candidateAuthService, createCandidateAuthRouter } from './modules/candidateAuth/index.js';
import { createExamRouter, examAuth, examService, ownsApplication } from './modules/exam/index.js';
import { createEvaluationRouter, evaluation } from './modules/evaluation/index.js';
import { createResultsRouter, results } from './modules/results/index.js';
import { aiEvaluation, createAiEvaluationRouter } from './modules/aiEvaluation/index.js';
import { audit, createAuditRouter } from './modules/audit/index.js';
import { createIntegrationsRouter, createIntegrationsService, integrationsRepository } from './modules/integrations/index.js';
import { createEmailTemplatesRouter, createEmailsRouter, emails } from './modules/emails/index.js';
import { sendEmail, sendSms } from './modules/messaging/index.js';
import { systemConfig } from './modules/systemConfig/index.js';
import { authenticateAdmin } from './shared/middleware/authenticateAdmin.js';
import { authorize } from './shared/middleware/authorize.js';

const integrationsService = createIntegrationsService({
  config: systemConfig,
  audit: (entry) => audit.record(entry),
  sendSms,
  sendEmail,
  testAi: aiEvaluation.testConnection,
  countCandidatesWithoutMobile: integrationsRepository.countCandidatesWithoutMobile,
});

const superAdminOnly = [authenticateAdmin, authorize('SUPER_ADMIN')];

export const router = Router();

router.use('/admin/auth', createAdminAuthRouter(adminAuthService));
router.use('/admin/users', ...superAdminOnly, createAdminUsersRouter(adminUsersService));
router.use('/admin/audit', ...superAdminOnly, createAuditRouter(audit));
router.use('/admin/integrations', ...superAdminOnly, createIntegrationsRouter(integrationsService));
router.use('/admin/ai-evaluations', ...superAdminOnly, createAiEvaluationRouter(aiEvaluation));
router.use('/admin/email-templates', ...superAdminOnly, createEmailTemplatesRouter(emails));
router.use('/admin/emails', ...superAdminOnly, createEmailsRouter(emails));
router.use('/admin/roles', authenticateAdmin, createJobRolesRouter(jobRoles));
router.use('/admin/roles', authenticateAdmin, createRoleQuestionsRouter(questions));
router.use('/admin/questions', authenticateAdmin, createQuestionsRouter(questions));
router.use('/admin/candidates', ...superAdminOnly, createCandidatesRouter(candidates));
router.use('/admin/submissions', authenticateAdmin, createEvaluationRouter(evaluation));
// Last /admin mount: dashboard, leaderboard, decisions, exports (per-route roles).
router.use('/admin', authenticateAdmin, createResultsRouter(results));
router.use('/candidate', createCandidateAuthRouter(candidateAuthService));
router.use('/candidate/exams', createExamRouter(examService, examAuth, ownsApplication));
