// infrastructure/config/env.ts
// Zod-validated environment; the process refuses to boot on a bad value.
// APP_ENV (local/uat/production, default 'local') picks which .env file loads,
// kept separate from NODE_ENV like the CRM does.

import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(4100),
    DATABASE_URL: z.string().min(1),
    /** Postgres connections per API process. A mass exam start holds one per in-flight start. */
    DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(20),
    REDIS_URL: z.string().min(1),
    JWT_ADMIN_SECRET: z.string().min(32),
    JWT_CANDIDATE_SECRET: z.string().min(32),
    CONFIG_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'CONFIG_ENCRYPTION_KEY must be 64 hex characters'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    COOKIE_SECURE: bool(false),
    PUBLIC_WEB_URL: z.string().min(1),
    CORS_ORIGIN: z.string().min(1),
    // Fails closed: the static code (123456) is on only when explicitly set true.
    ALLOW_STATIC_OTP: bool(false),
    LOG_DIR: z.string().default('./logs'),
    SEED_ADMIN_EMAIL: z.string().optional(),
    SEED_ADMIN_PASSWORD: z.string().optional(),
  })
  .refine((e) => e.JWT_ADMIN_SECRET !== e.JWT_CANDIDATE_SECRET, {
    message: 'JWT_CANDIDATE_SECRET must differ from JWT_ADMIN_SECRET',
    path: ['JWT_CANDIDATE_SECRET'],
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

const APP_ENV = process.env.APP_ENV ?? 'local';
dotenv.config({ path: path.resolve(process.cwd(), `.env.${APP_ENV}`) });

export const env: Env = loadEnv(process.env);
