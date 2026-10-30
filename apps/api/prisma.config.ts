// prisma.config.ts
// Loads the same per-environment file as src/infrastructure/config/env.ts
// (APP_ENV=local/uat/production/test, default 'local') so `prisma migrate` and
// the app always point at the same database for a given environment.

import dotenv from 'dotenv';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

const APP_ENV = process.env.APP_ENV ?? 'local';
dotenv.config({ path: path.resolve(process.cwd(), `.env.${APP_ENV}`) });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
