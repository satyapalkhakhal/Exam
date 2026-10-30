// modules/results/results.routes.ts
// Mounted at /admin behind authenticateAdmin in router.ts, after every other
// admin router. The dashboard is open to any admin (counts only); decisions,
// the leaderboard and exports are Super Admin only.

import { Router } from 'express';
import { z } from 'zod';
import { DecisionSchema, ExportQuerySchema, LeaderboardQuerySchema } from '@exam/shared';
import { authorize } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';
import { createResultsController } from './results.controller.js';
import type { ResultsService } from './results.service.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });

export function createResultsRouter(service: ResultsService): Router {
  const c = createResultsController(service);
  const r = Router();
  const superAdmin = authorize('SUPER_ADMIN');
  r.get('/dashboard', authorize('SUPER_ADMIN', 'EVALUATOR'), c.dashboard);
  r.get('/leaderboard', superAdmin, validate({ query: LeaderboardQuerySchema }), c.leaderboard);
  r.post('/candidates/:id/decision', superAdmin, validate({ params: IdParamsSchema, body: DecisionSchema }), c.decide);
  r.get('/exports/results.xlsx', superAdmin, validate({ query: ExportQuerySchema }), c.resultsExport);
  r.get('/exports/activity.xlsx', superAdmin, validate({ query: ExportQuerySchema }), c.activityExport);
  return r;
}
