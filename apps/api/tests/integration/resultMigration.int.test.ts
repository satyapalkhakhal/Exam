// The 20261105091000_candidate_result back-fill, run against exam_test: candidates
// whose status was overwritten by a decision get the decision as `result` and go
// back to EVALUATED. The SQL is read from the migration file itself (between the
// BACKFILL markers) so the test exercises exactly what ships.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { createCandidate } from './helpers.js';

const MIGRATION = path.resolve(import.meta.dirname, '../../prisma/migrations/20261105091000_candidate_result/migration.sql');
const RUN = crypto.randomBytes(3).toString('hex');

function backfillSql(): string[] {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const m = /-- BACKFILL START\n([\s\S]*?)-- BACKFILL END/.exec(sql);
  assert.ok(m, 'migration has BACKFILL markers');
  return m[1]!
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

let roleId = '';

before(async () => {
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  roleId = (await prisma.jobRole.create({ data: { name: `Backfill ${RUN}` } })).id;
});

after(async () => {
  await prisma.$disconnect();
});

test('back-fill SQL moves decided statuses into result', async () => {
  const admin = await prisma.adminUser.create({ data: { email: `bf-${RUN}@x.test`, name: 'BF', passwordHash: 'x', role: 'SUPER_ADMIN' } });
  const base = (key: string) => ({ candidateCode: `BF-${RUN}-${key}`, fullName: `BF ${key}`, email: `bf-${key}-${RUN}@x.test`, jobRoleId: roleId });
  const shortlisted = await createCandidate({ ...base('s'), status: 'SHORTLISTED' });
  const rejected = await createCandidate({ ...base('r'), status: 'REJECTED' });
  const evaluated = await createCandidate({ ...base('e'), status: 'EVALUATED' });
  const decidedAt = new Date('2026-11-02T10:00:00Z');
  await prisma.candidateStatusHistory.create({
    data: { candidateId: shortlisted.id, fromStatus: 'EVALUATED', toStatus: 'SHORTLISTED', byAdminId: admin.id, createdAt: decidedAt },
  });

  for (const stmt of backfillSql()) await prisma.$executeRawUnsafe(stmt);

  const rows = await prisma.candidate.findMany({
    where: { id: { in: [shortlisted.id, rejected.id, evaluated.id] } },
    select: { id: true, status: true, result: true, resultAt: true, resultById: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.deepEqual(
    { status: byId.get(shortlisted.id)!.status, result: byId.get(shortlisted.id)!.result, by: byId.get(shortlisted.id)!.resultById },
    { status: 'EVALUATED', result: 'SHORTLISTED', by: admin.id },
  );
  assert.equal(byId.get(shortlisted.id)!.resultAt?.toISOString(), decidedAt.toISOString());
  assert.deepEqual({ status: byId.get(rejected.id)!.status, result: byId.get(rejected.id)!.result }, { status: 'EVALUATED', result: 'REJECTED' });
  assert.deepEqual({ status: byId.get(evaluated.id)!.status, result: byId.get(evaluated.id)!.result }, { status: 'EVALUATED', result: null });
  assert.equal(await prisma.candidate.count({ where: { status: { in: ['SHORTLISTED', 'REJECTED'] } } }), 0);
});
