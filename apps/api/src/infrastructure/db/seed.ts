// infrastructure/db/seed.ts
// Idempotent seed: the 7 job roles with default exam settings, disabled SMS and
// email config rows, and the Super Admin from SEED_ADMIN_EMAIL/PASSWORD (never
// overwritten once it exists). SEED_DEMO=true adds 3 candidates + 2 questions
// on the Backend Engineer role. Usage: pnpm --filter @exam/api seed

import bcrypt from 'bcrypt';
import { normalizeMobile } from '@exam/shared';
import { prisma } from './prisma.js';
import { env } from '../config/env.js';
import { seedData } from './seed.data.js';
import { questionHash } from '../../shared/utils/questionHash.js';

export { seedData };

const BCRYPT_ROUNDS = 12;

async function seedRoles(): Promise<void> {
  for (const r of seedData.roles) {
    const role = await prisma.jobRole.upsert({
      where: { name: r.name },
      update: { refApplicantCount: r.refApplicantCount },
      create: r,
    });
    await prisma.examSetting.upsert({
      where: { jobRoleId: role.id },
      update: {},
      create: { jobRoleId: role.id },
    });
  }
}

async function seedConfigs(): Promise<void> {
  for (const c of seedData.configs) {
    await prisma.systemConfig.upsert({
      where: { key: c.key },
      update: {},
      create: { key: c.key, value: c.value, isSecret: c.isSecret },
    });
  }
}

async function seedSuperAdmin(): Promise<void> {
  const email = env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set; skipping Super Admin');
    return;
  }
  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) return;
  const rawMobile = env.SEED_ADMIN_MOBILE?.trim();
  const mobile = rawMobile ? normalizeMobile(rawMobile) : null;
  if (rawMobile && !mobile) console.warn('SEED_ADMIN_MOBILE is not a valid 10-digit mobile; seeding without it');
  await prisma.adminUser.create({
    data: {
      email,
      mobile,
      name: 'Super Admin',
      role: 'SUPER_ADMIN',
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    },
  });
}

async function seedDemo(): Promise<void> {
  const role = await prisma.jobRole.findUniqueOrThrow({ where: { name: seedData.demo.roleName } });
  for (const c of seedData.demo.candidates) {
    await prisma.candidate.upsert({
      where: { candidateCode: c.candidateCode },
      update: {},
      create: { ...c, jobRoleId: role.id },
    });
  }
  for (const [i, q] of seedData.demo.questions.entries()) {
    const normalizedTextHash = questionHash(q.text);
    await prisma.question.upsert({
      where: { jobRoleId_normalizedTextHash: { jobRoleId: role.id, normalizedTextHash } },
      update: {},
      create: { ...q, jobRoleId: role.id, normalizedTextHash, displayOrder: i + 1 },
    });
  }
}

async function main(): Promise<void> {
  await seedRoles();
  await seedConfigs();
  await seedSuperAdmin();
  if (process.env.SEED_DEMO === 'true') await seedDemo();
  console.log('Seed complete');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err: unknown) => {
      console.error('Seed failed', err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
