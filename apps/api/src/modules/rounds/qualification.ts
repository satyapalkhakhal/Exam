// modules/rounds/qualification.ts
// Interim qualification rule (spec 5.3): a SHORTLISTED decision on a round
// entry qualifies the person for the next round of the same exam by creating
// that round's entry. Un-shortlisting / reopening / resetting removes the next
// entry again, but only while it has no attempt.
// Why shared: the exams module (a round added late) and the decision/reset
// flows (task 7) must apply the exact same rule. All functions run on the
// caller's transaction. Lock order: candidate -> exam row -> round entry ->
// attempt, so callers lock the candidate first. grant/revoke take the exam row
// FOR SHARE before the entry (so they queue behind an in-flight add-round,
// which holds it FOR UPDATE) and read the next round only afterwards, in a
// fresh statement, so a just-committed new round is visible (READ COMMITTED).

import type { Prisma } from '../../generated/prisma/client.js';
import { conflict, notFound } from '../../shared/errors.js';

type Tx = Prisma.TransactionClient;

interface EntryContext {
  id: string;
  registration_id: string;
  candidate_id: string;
  exam_id: string;
  round_number: number;
}

/** Takes the entry's exam row FOR SHARE (waits for an in-flight add-round). */
async function shareLockExam(tx: Tx, entryId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ exam_id: string }[]>`
    SELECT r.exam_id::text AS exam_id
    FROM round_entries re JOIN exam_rounds r ON r.id = re.round_id
    WHERE re.id = ${entryId}::uuid`;
  const examId = rows[0]?.exam_id;
  if (!examId) throw notFound('Round entry not found');
  await tx.$queryRaw`SELECT 1 FROM exams WHERE id = ${examId}::uuid FOR SHARE`;
}

/** The entry with its exam position, row-locked. */
async function lockEntry(tx: Tx, entryId: string): Promise<EntryContext> {
  const rows = await tx.$queryRaw<EntryContext[]>`
    SELECT re.id::text AS id, re.registration_id::text AS registration_id,
           reg.candidate_id::text AS candidate_id, r.exam_id::text AS exam_id, r.round_number
    FROM round_entries re
    JOIN exam_registrations reg ON reg.id = re.registration_id
    JOIN exam_rounds r ON r.id = re.round_id
    WHERE re.id = ${entryId}::uuid
    FOR UPDATE OF re`;
  const row = rows[0];
  if (!row) throw notFound('Round entry not found');
  return row;
}

const nextRoundOf = (tx: Tx, ctx: EntryContext) =>
  tx.examRound.findFirst({
    where: { examId: ctx.exam_id, roundNumber: { gt: ctx.round_number } },
    orderBy: { roundNumber: 'asc' },
    select: { id: true },
  });

/**
 * Creates the next round's entry (NOT_STARTED) for the entry's person, with its
 * first history row. Returns the new entry's id; the existing one's id when it
 * is already there; null when the entry is in the exam's last round.
 */
export async function grantNextRound(tx: Tx, entryId: string, adminId: string): Promise<string | null> {
  await shareLockExam(tx, entryId);
  const ctx = await lockEntry(tx, entryId);
  const next = await nextRoundOf(tx, ctx);
  if (!next) return null;
  const existing = await tx.roundEntry.findUnique({
    where: { registrationId_roundId: { registrationId: ctx.registration_id, roundId: next.id } },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await tx.roundEntry.create({
    data: { registrationId: ctx.registration_id, roundId: next.id },
    select: { id: true },
  });
  await tx.candidateStatusHistory.create({
    data: {
      candidateId: ctx.candidate_id,
      roundEntryId: created.id,
      fromStatus: null,
      toStatus: 'NOT_STARTED',
      byAdminId: adminId,
    },
  });
  return created.id;
}

/**
 * Removes the next round's entry for the entry's person if it has no attempt
 * (its history rows go with it). 'none' when there is nothing to remove.
 * Throws CONFLICT when the person already has an attempt in the next round.
 */
export async function revokeNextRound(tx: Tx, entryId: string): Promise<'removed' | 'none'> {
  await shareLockExam(tx, entryId);
  const ctx = await lockEntry(tx, entryId);
  const next = await nextRoundOf(tx, ctx);
  if (!next) return 'none';
  const nextEntry = await tx.roundEntry.findUnique({
    where: { registrationId_roundId: { registrationId: ctx.registration_id, roundId: next.id } },
    select: { id: true },
  });
  if (!nextEntry) return 'none';
  await tx.$queryRaw`SELECT id FROM round_entries WHERE id = ${nextEntry.id}::uuid FOR UPDATE`;
  const attempts = await tx.examAttempt.count({ where: { roundEntryId: nextEntry.id } });
  if (attempts > 0) throw conflict('The candidate has already started the next round.');
  await tx.candidateStatusHistory.deleteMany({ where: { roundEntryId: nextEntry.id } });
  await tx.roundEntry.delete({ where: { id: nextEntry.id } });
  return 'removed';
}

/**
 * A round was just added after the exam's previous last round: every entry
 * SHORTLISTED in that previous round gets an entry in the new round. Returns
 * how many were created.
 */
export async function backfillNewRound(tx: Tx, newRoundId: string, adminId: string): Promise<number> {
  const round = await tx.examRound.findUnique({
    where: { id: newRoundId },
    select: { examId: true, roundNumber: true },
  });
  if (!round) throw notFound('Round not found');
  const previous = await tx.examRound.findFirst({
    where: { examId: round.examId, roundNumber: { lt: round.roundNumber } },
    orderBy: { roundNumber: 'desc' },
    select: { id: true },
  });
  if (!previous) return 0;
  const shortlisted = await tx.$queryRaw<{ registration_id: string; candidate_id: string }[]>`
    SELECT re.registration_id::text AS registration_id, reg.candidate_id::text AS candidate_id
    FROM round_entries re
    JOIN exam_registrations reg ON reg.id = re.registration_id
    WHERE re.round_id = ${previous.id}::uuid AND re.status = 'SHORTLISTED'
    FOR UPDATE OF re`;
  let created = 0;
  for (const s of shortlisted) {
    const entry = await tx.roundEntry.create({
      data: { registrationId: s.registration_id, roundId: newRoundId },
      select: { id: true },
    });
    await tx.candidateStatusHistory.create({
      data: {
        candidateId: s.candidate_id,
        roundEntryId: entry.id,
        fromStatus: null,
        toStatus: 'NOT_STARTED',
        byAdminId: adminId,
      },
    });
    created += 1;
  }
  return created;
}
