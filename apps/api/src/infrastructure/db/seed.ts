// infrastructure/db/seed.ts
// Idempotent seed: the 7 job roles (placement) each with Round 1, disabled SMS and
// email config rows, and the Super Admin from SEED_ADMIN_EMAIL/PASSWORD (never
// overwritten once it exists). SEED_DEMO=true adds a DEMO college, a "Demo" drive of
// Backend Engineer Round 1, 3 candidates in it (each with its sign-in account) and
// 2 written questions and 2 MCQs on that round (spec 2026-11-10). Usage: pnpm --filter @exam/api seed

import bcrypt from 'bcrypt';
import { normalizeMobile } from '@exam/shared';
import { prisma } from './prisma.js';
import { env } from '../config/env.js';
import { seedData } from './seed.data.js';
import { hashFor, questionHash } from '../../shared/utils/questionHash.js';

export { seedData };

const BCRYPT_ROUNDS = 12;

/** The placement job profile of this name (names are unique per type, case-insensitively). */
const placementRole = (name: string) =>
  prisma.jobRole.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, type: 'PLACEMENT' } });

async function seedRoles(): Promise<void> {
  for (const r of seedData.roles) {
    const existing = await placementRole(r.name);
    const role = existing
      ? await prisma.jobRole.update({ where: { id: existing.id }, data: { refApplicantCount: r.refApplicantCount } })
      : await prisma.jobRole.create({ data: { ...r, type: 'PLACEMENT' } });
    await prisma.examRound.upsert({
      where: { jobRoleId_roundNumber: { jobRoleId: role.id, roundNumber: 1 } },
      update: {},
      create: { jobRoleId: role.id, roundNumber: 1 },
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
  const { demo } = seedData;
  const role = await placementRole(demo.roleName);
  if (!role) throw new Error(`Seed: job profile ${demo.roleName} is missing`);
  const round = await prisma.examRound.findUniqueOrThrow({ where: { jobRoleId_roundNumber: { jobRoleId: role.id, roundNumber: 1 } } });
  const college =
    (await prisma.college.findFirst({ where: { shortCode: demo.college.shortCode } })) ??
    (await prisma.college.create({ data: demo.college }));
  const drive =
    (await prisma.drive.findFirst({ where: { roundId: round.id, collegeId: college.id, batch: { equals: demo.batch, mode: 'insensitive' } } })) ??
    (await prisma.drive.create({ data: { roundId: round.id, collegeId: college.id, batch: demo.batch } }));
  for (const c of seedData.demo.candidates) {
    const account = await prisma.candidateAccount.upsert({
      where: { email: c.email },
      update: {},
      create: { email: c.email, mobile: c.mobile },
    });
    await prisma.candidate.upsert({
      where: { candidateCode: c.candidateCode },
      update: {},
      create: { ...c, accountId: account.id, jobRoleId: role.id, driveId: drive.id },
    });
  }
  for (const [i, q] of seedData.demo.questions.entries()) {
    const normalizedTextHash = questionHash(q.text);
    await prisma.question.upsert({
      where: { roundId_normalizedTextHash: { roundId: round.id, normalizedTextHash } },
      update: {},
      create: { ...q, roundId: round.id, normalizedTextHash, displayOrder: i + 1 },
    });
  }
  const offset = seedData.demo.questions.length;
  for (const [i, q] of seedData.demo.mcqQuestions.entries()) {
    const normalizedTextHash = hashFor({ type: 'MCQ', text: q.text, options: [...q.options] });
    await prisma.question.upsert({
      where: { roundId_normalizedTextHash: { roundId: round.id, normalizedTextHash } },
      update: {},
      create: { ...q, options: [...q.options], type: 'MCQ', roundId: round.id, normalizedTextHash, displayOrder: offset + i + 1 },
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
