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

export type NewCandidate = Omit<Prisma.CandidateUncheckedCreateInput, 'id' | 'accountId'> & { email: string };

/** A new person: account + first application. */
export async function createCandidate(data: NewCandidate) {
  const id = crypto.randomUUID();
  await prisma.candidateAccount.create({ data: { id, email: data.email, mobile: data.mobile ?? null } });
  return prisma.candidate.create({ data: { ...data, id, accountId: id } });
}

export async function createCandidates(rows: NewCandidate[]): Promise<{ id: string }[]> {
  const ids = rows.map(() => crypto.randomUUID());
  await prisma.candidateAccount.createMany({ data: rows.map((r, i) => ({ id: ids[i]!, email: r.email, mobile: r.mobile ?? null })) });
  await prisma.candidate.createMany({ data: rows.map((r, i) => ({ ...r, id: ids[i]!, accountId: ids[i]! })) });
  return ids.map((id) => ({ id }));
}

/** Another application (job role) for an existing account. */
export async function createApplication(accountId: string, data: Omit<NewCandidate, 'email' | 'mobile'>) {
  const account = await prisma.candidateAccount.findUniqueOrThrow({ where: { id: accountId } });
  return prisma.candidate.create({ data: { ...data, accountId, email: account.email, mobile: account.mobile } });
}
