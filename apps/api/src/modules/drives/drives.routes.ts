// modules/drives/drives.routes.ts
// Mounted at /admin in router.ts behind authenticateAdmin; every route is
// Super Admin only, applied per route (a router-level guard would also catch
// the other /admin routers' requests passing through) (colleges and drives are hidden from Evaluators: blind marking).
//   /admin/colleges            GET, POST; /admin/colleges/:id PATCH
//   /admin/roles/:id/rounds    POST (next round number)
//   /admin/rounds/:id          PUT (duration, name, weights)
//   /admin/rounds/:id/drives   POST
//   /admin/drives              GET (filters); /admin/drives/:id PATCH
//   /admin/drives/:id/promote  POST (move shortlisted to round n+1, same college + batch)

import { Router } from 'express';
import { z } from 'zod';
import {
  CollegeCreateSchema,
  CollegeUpdateSchema,
  DriveCreateSchema,
  DriveListQuerySchema,
  DriveUpdateSchema,
  RoundCreateSchema,
  RoundSettingsSchema,
} from '@exam/shared';
import { authorize } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';
import { createDrivesController } from './drives.controller.js';
import type { DrivesService } from './drives.service.js';

const IdParams = z.object({ id: z.string().uuid() });

export function createDrivesRouter(service: DrivesService): Router {
  const c = createDrivesController(service);
  const r = Router();
  const sa = authorize('SUPER_ADMIN');
  r.get('/colleges', sa, c.listColleges);
  r.post('/colleges', sa, validate({ body: CollegeCreateSchema }), c.createCollege);
  r.patch('/colleges/:id', sa, validate({ params: IdParams, body: CollegeUpdateSchema }), c.updateCollege);
  r.post('/roles/:id/rounds', sa, validate({ params: IdParams, body: RoundCreateSchema }), c.addRound);
  r.put('/rounds/:id', sa, validate({ params: IdParams, body: RoundSettingsSchema }), c.updateRound);
  r.post('/rounds/:id/drives', sa, validate({ params: IdParams, body: DriveCreateSchema }), c.createDrive);
  r.get('/drives', sa, validate({ query: DriveListQuerySchema }), c.listDrives);
  r.patch('/drives/:id', sa, validate({ params: IdParams, body: DriveUpdateSchema }), c.updateDrive);
  r.post('/drives/:id/promote', sa, validate({ params: IdParams }), c.promote);
  return r;
}
