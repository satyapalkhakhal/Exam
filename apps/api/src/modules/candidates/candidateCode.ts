// modules/candidates/candidateCode.ts
// Candidate codes (ARH-EX-000123) come from a Postgres sequence, so concurrent
// imports can never mint the same code. Gaps after a rolled-back import are fine.

import { prisma } from '../../infrastructure/db/prisma.js';

export const formatCandidateCode = (n: number): string => `ARH-EX-${String(n).padStart(6, '0')}`;

export async function nextCandidateCodes(n: number): Promise<string[]> {
  if (n <= 0) return [];
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval('candidate_code_seq') AS n FROM generate_series(1, ${n}::int)`;
  return rows.map((r) => formatCandidateCode(Number(r.n)));
}
