// tests/integration/helpers.ts
// Test data for the candidate tables. A candidate row is an application that
// hangs off a candidate account (docs/multi-exam.md); these helpers create the
// account too. The account reuses the new candidate's id, exactly as the
// migration backfill does, so a test that signs in as "the candidate" gets an
// account id equal to its (only) application id. Use createApplication for the
// second and later roles of one person.

import crypto from 'node:crypto';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';

/** jobRoleId may be left out: it is filled from the drive (drive -> round -> job role). */
export type NewCandidate = Omit<Prisma.CandidateUncheckedCreateInput, 'id' | 'accountId' | 'jobRoleId'> & { email: string; jobRoleId?: string };

const roleOfDrive = new Map<string, string>();
async function withRole<T extends { driveId: string; jobRoleId?: string }>(data: T): Promise<T & { jobRoleId: string }> {
  if (data.jobRoleId) return data as T & { jobRoleId: string };
  let jobRoleId = roleOfDrive.get(data.driveId);
  if (!jobRoleId) {
    jobRoleId = (await prisma.drive.findUniqueOrThrow({ where: { id: data.driveId }, select: { round: { select: { jobRoleId: true } } } })).round.jobRoleId;
    roleOfDrive.set(data.driveId, jobRoleId);
  }
  return { ...data, jobRoleId };
}

/** A new person: account + first application. */
export async function createCandidate(data: NewCandidate) {
  const id = crypto.randomUUID();
  await prisma.candidateAccount.create({ data: { id, email: data.email, mobile: data.mobile ?? null } });
  return prisma.candidate.create({ data: { ...(await withRole(data)), id, accountId: id } });
}

export async function createCandidates(rows: NewCandidate[]): Promise<{ id: string }[]> {
  const ids = rows.map(() => crypto.randomUUID());
  await prisma.candidateAccount.createMany({ data: rows.map((r, i) => ({ id: ids[i]!, email: r.email, mobile: r.mobile ?? null })) });
  const full = await Promise.all(rows.map((r) => withRole(r)));
  await prisma.candidate.createMany({ data: full.map((r, i) => ({ ...r, id: ids[i]!, accountId: ids[i]! })) });
  return ids.map((id) => ({ id }));
}

/** Another application (another drive) for an existing account. */
export async function createApplication(accountId: string, data: Omit<NewCandidate, 'email' | 'mobile'>) {
  const account = await prisma.candidateAccount.findUniqueOrThrow({ where: { id: accountId } });
  return prisma.candidate.create({ data: { ...(await withRole(data)), accountId, email: account.email, mobile: account.mobile } });
}

/** A job role (job profile) with Round 1 and one drive; returns the drive's ids. */
export async function createRoleWithDrive(name: string, opts: Parameters<typeof createDrive>[1] = {}) {
  const role = await prisma.jobRole.create({ data: { name } });
  return { jobRoleId: role.id, ...(await createDrive(role.id, opts)) };
}

/**
 * Round 1 of the job role plus a drive at a test college (spec 2026-11-10):
 * every candidate needs a drive. Reuses round 1 when it exists; `college`
 * picks (or creates) a college by short code, `batch` defaults to a fresh label
 * so repeated calls give separate drives.
 */
export async function createDrive(
  jobRoleId: string,
  opts: { roundNumber?: number; college?: string; batch?: string; isOpen?: boolean; windowStart?: Date | null; windowEnd?: Date | null; durationMinutes?: number; instructions?: string } = {},
): Promise<{ roundId: string; driveId: string; collegeId: string }> {
  const roundNumber = opts.roundNumber ?? 1;
  const round = await prisma.examRound.upsert({
    where: { jobRoleId_roundNumber: { jobRoleId, roundNumber } },
    create: { jobRoleId, roundNumber, ...(opts.durationMinutes ? { durationMinutes: opts.durationMinutes } : {}) },
    update: opts.durationMinutes ? { durationMinutes: opts.durationMinutes } : {},
  });
  const code = (opts.college ?? 'TST').toUpperCase();
  const existing = await prisma.college.findFirst({ where: { shortCode: code } });
  const college = existing ?? (await prisma.college.create({ data: { name: `College ${code}`, shortCode: code } }));
  const drive = await prisma.drive.create({
    data: {
      roundId: round.id,
      collegeId: college.id,
      batch: opts.batch ?? `B-${crypto.randomBytes(3).toString('hex')}`,
      isOpen: opts.isOpen ?? false,
      windowStart: opts.windowStart ?? null,
      windowEnd: opts.windowEnd ?? null,
      ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
    },
  });
  return { roundId: round.id, driveId: drive.id, collegeId: college.id };
}
