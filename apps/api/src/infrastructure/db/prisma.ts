// infrastructure/db/prisma.ts
// The single PrismaClient for the API, on the pg driver adapter so the app has
// one connection pool and one place that reads DATABASE_URL.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { env } from '../config/env.js';

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL, max: env.DB_POOL_MAX });

export const prisma = new PrismaClient({ adapter });
