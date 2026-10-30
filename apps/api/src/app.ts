// app.ts
// Builds the Express app (no listen) so tests can drive it with supertest.

import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './infrastructure/config/env.js';
import { ok } from './shared/http.js';
import { errorHandler } from './shared/middleware/errorHandler.js';
import { requestId } from './shared/middleware/requestId.js';
import { router } from './router.js';

export function createApp(): express.Express {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(requestId);
  app.use('/api', router);
  app.get('/health', (_req, res) => {
    ok(res, { status: 'ok' });
  });
  app.use(errorHandler);
  return app;
}

export const app = createApp();
