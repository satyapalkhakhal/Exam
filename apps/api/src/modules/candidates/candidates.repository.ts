// modules/candidates/candidates.repository.ts
// candidates (people), their exam registrations and round entries, and their
// logs. Every write commits with its audit row. The unique email/mobile and
// (candidate, exam) indexes are the final arbiter of duplicates, so concurrent
// imports or edits cannot slip one past the service.
// Lock order (global): candidate row -> exam row (FOR SHARE) -> round entry ->
// attempt. Registering takes the exam FOR SHARE so it queues behind an
// in-flight add-round / deactivation and reads the committed state.

import type { CandidateListQuery } from '@exam/shared';
import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { conflict, notFound } from '../../shared/errors.js';
import { writeAudit } from '../audit/index.js';
import { revokeNextRound } from '../rounds/qualification.js';
import type { ExamRef, ExistingPerson } from './candidateImport.parser.js';
import {
  EXAM_HAS_NO_ROUNDS,
  EXAM_INACTIVE,
  NOTHING_TO_RESET,
  type CandidatesRepository,
  type RegistrationRow,
} from './candidates.service.js';

type Tx = Prisma.TransactionClient;

const isUnique = (err: unknown): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
const PERSON_TAKEN = 'Another candidate already has this email or mobile.';
const ALREADY_REGISTERED = 'Already registered for this exam.';

const examSelect = { id: true, name: true, jobRoleId: true, jobRole: { select: { name: true } } } as const;
const entrySelect = {
  id: true,
  status: true,
  round: { select: { id: true, roundNumber: true, name: true } },
  attempts: {
    where: { status: { not: 'RESET' } },
    orderBy: { startedAt: 'desc' },
    take: 1,
    select: { id: true, status: true, startedAt: true, submittedAt: true },
  },
} satisfies Prisma.RoundEntrySelect;
const registrationSelect = {
  id: true,
  exam: { select: examSelect },
  entries: { orderBy: { round: { roundNumber: 'asc' } }, select: entrySelect },
} satisfies Prisma.ExamRegistrationSelect;
const personInclude = {
  registrations: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: registrationSelect },
} satisfies Prisma.CandidateInclude;
const listInclude = {
  ...entrySelect,
  registration: { select: { exam: { select: examSelect }, candidate: true } },
} satisfies Prisma.RoundEntrySelect;

function listWhere(q: CandidateListQuery): Prisma.RoundEntryWhereInput {
  return {
    ...(q.roundId ? { roundId: q.roundId } : {}),
    ...(q.status ? { status: q.status } : {}),
    registration: {
      ...(q.examId ? { examId: q.examId } : {}),
      ...(q.jobRoleId ? { exam: { jobRoleId: q.jobRoleId } } : {}),
      ...(q.search
        ? {
            candidate: {
              OR: [
                { fullName: { contains: q.search, mode: 'insensitive' } },
                { email: { contains: q.search, mode: 'insensitive' } },
                { rollNumber: { contains: q.search, mode: 'insensitive' } },
                { candidateCode: { contains: q.search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    },
  };
}

const lockCandidate = async (tx: Tx, id: string): Promise<boolean> =>
  (await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM candidates WHERE id = ${id}::uuid FOR UPDATE`).length > 0;

/** The exam FOR SHARE with its first round; NOT_FOUND / CONFLICT unless it can take registrations. */
async function lockUsableExam(tx: Tx, examId: string): Promise<{ firstRoundId: string }> {
  const rows = await tx.$queryRaw<{ active: boolean }[]>`SELECT active FROM exams WHERE id = ${examId}::uuid FOR SHARE`;
  if (rows.length === 0) throw notFound('Exam not found');
  if (!rows[0]!.active) throw conflict(EXAM_INACTIVE);
  const first = await tx.examRound.findFirst({ where: { examId }, orderBy: { roundNumber: 'asc' }, select: { id: true } });
  if (!first) throw conflict(EXAM_HAS_NO_ROUNDS);
  return { firstRoundId: first.id };
}

/** Registration + Round 1 entry + its first history row, on the caller's transaction (exam already locked). */
async function addRegistration(tx: Tx, candidateId: string, examId: string, firstRoundId: string, adminId: string): Promise<string> {
  const reg = await tx.examRegistration.create({ data: { candidateId, examId }, select: { id: true } });
  const entry = await tx.roundEntry.create({ data: { registrationId: reg.id, roundId: firstRoundId }, select: { id: true } });
  await tx.candidateStatusHistory.create({
    data: { candidateId, roundEntryId: entry.id, fromStatus: null, toStatus: 'NOT_STARTED', byAdminId: adminId },
  });
  return reg.id;
}

export const candidatesRepository: CandidatesRepository = {
  async examForRegistration(id) {
    const exam = await prisma.exam.findUnique({
      where: { id },
      select: { id: true, active: true, rounds: { orderBy: { roundNumber: 'asc' }, take: 1, select: { id: true } } },
    });
    return exam ? { id: exam.id, active: exam.active, firstRoundId: exam.rounds[0]?.id ?? null } : null;
  },

  async examsByLowerName() {
    const exams = await prisma.exam.findMany({ select: { id: true, name: true, active: true, _count: { select: { rounds: true } } } });
    return new Map<string, ExamRef>(
      exams.map((e) => [e.name.trim().toLowerCase(), { id: e.id, active: e.active, hasRounds: e._count.rounds > 0 }]),
    );
  },

  async importContext() {
    const rows = await prisma.candidate.findMany({
      select: { id: true, email: true, mobile: true, registrations: { select: { examId: true } } },
    });
    const peopleByEmail = new Map<string, ExistingPerson>();
    const personIdByMobile = new Map<string, string>();
    for (const r of rows) {
      peopleByEmail.set(r.email.toLowerCase(), { id: r.id, mobile: r.mobile, examIds: new Set(r.registrations.map((g) => g.examId)) });
      if (r.mobile) personIdByMobile.set(r.mobile, r.id);
    }
    return { peopleByEmail, personIdByMobile };
  },

  async lastImportOf(examId, fileHash) {
    const batch = await prisma.importBatch.findFirst({
      where: { kind: 'CANDIDATES', examId, fileHash },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return batch?.createdAt ?? null;
  },

  confirmImport(input) {
    return prisma.$transaction(
      async (tx) => {
        const batch = await tx.importBatch.create({
          data: {
            kind: 'CANDIDATES',
            examId: input.examId,
            fileName: input.fileName,
            fileHash: input.fileHash,
            uploadedById: input.uploadedById,
            total: input.total,
            errors: input.errors as Prisma.InputJsonValue,
          },
        });
        // Every exam the rows register into, locked in a fixed order.
        const firstRound = new Map<string, string>();
        for (const examId of [...new Set(input.rows.map((r) => r.examId))].sort()) {
          firstRound.set(examId, (await lockUsableExam(tx, examId)).firstRoundId);
        }
        // New people (skipDuplicates: a person created meanwhile is simply registered).
        await tx.candidate.createMany({
          data: input.rows.flatMap((r) =>
            r.candidateCode === null
              ? []
              : [
                  {
                    candidateCode: r.candidateCode,
                    fullName: r.fullName,
                    email: r.email,
                    mobile: r.mobile,
                    rollNumber: r.rollNumber,
                    xPercentage: r.xPercentage,
                    xiiPercentage: r.xiiPercentage,
                    majorCpi: r.majorCpi,
                    discipline: r.discipline,
                    programme: r.programme,
                    extra: r.extra as Prisma.InputJsonValue,
                    importBatchId: batch.id,
                  },
                ],
          ),
          skipDuplicates: true,
        });
        const people = await tx.candidate.findMany({
          where: { email: { in: [...new Set(input.rows.map((r) => r.email))] } },
          select: { id: true, email: true },
        });
        const idByEmail = new Map(people.map((p) => [p.email, p.id]));
        await tx.examRegistration.createMany({
          data: input.rows.flatMap((r) => {
            const candidateId = idByEmail.get(r.email);
            return candidateId ? [{ candidateId, examId: r.examId, importBatchId: batch.id }] : [];
          }),
          skipDuplicates: true,
        });
        const regs = await tx.examRegistration.findMany({
          where: { importBatchId: batch.id },
          select: { id: true, candidateId: true, examId: true },
        });
        await tx.roundEntry.createMany({ data: regs.map((g) => ({ registrationId: g.id, roundId: firstRound.get(g.examId)! })) });
        const entries = await tx.roundEntry.findMany({
          where: { registrationId: { in: regs.map((g) => g.id) } },
          select: { id: true, registration: { select: { candidateId: true } } },
        });
        await tx.candidateStatusHistory.createMany({
          data: entries.map((e) => ({
            candidateId: e.registration.candidateId,
            roundEntryId: e.id,
            fromStatus: null,
            toStatus: 'NOT_STARTED' as const,
            byAdminId: input.uploadedById,
          })),
        });
        const count = regs.length;
        await tx.importBatch.update({ where: { id: batch.id }, data: { imported: count, skipped: input.total - count } });
        await writeAudit(tx, input.audit(count));
        return count;
      },
      { timeout: 60_000 },
    );
  },

  async findIdByEmail(email) {
    return (await prisma.candidate.findUnique({ where: { email: email.toLowerCase() }, select: { id: true } }))?.id ?? null;
  },

  async create(data, examId, adminId, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        const row = await tx.candidate.create({
          data: {
            candidateCode: data.candidateCode,
            fullName: data.fullName,
            email: data.email,
            mobile: data.mobile ?? null,
            rollNumber: data.rollNumber ?? null,
            xPercentage: data.xPercentage ?? null,
            xiiPercentage: data.xiiPercentage ?? null,
            majorCpi: data.majorCpi ?? null,
            discipline: data.discipline ?? null,
            programme: data.programme ?? null,
          },
          select: { id: true },
        });
        const { firstRoundId } = await lockUsableExam(tx, examId);
        await addRegistration(tx, row.id, examId, firstRoundId, adminId);
        await writeAudit(tx, audit(row.id));
        return tx.candidate.findUniqueOrThrow({ where: { id: row.id }, include: personInclude });
      });
    } catch (err) {
      if (isUnique(err)) throw conflict(PERSON_TAKEN);
      throw err;
    }
  },

  async possiblyFlaggedEntries(q) {
    // Every review flag needs integrity events or an exam-start location row.
    const rows = await prisma.roundEntry.findMany({
      where: {
        AND: [
          listWhere(q),
          { registration: { candidate: { OR: [{ activityLogs: { some: {} } }, { loginLogs: { some: { stage: 'EXAM_START' } } }] } } },
        ],
      },
      select: {
        id: true,
        registration: { select: { candidateId: true } },
        attempts: { where: { status: { not: 'RESET' } }, take: 1, select: { id: true } },
      },
    });
    return rows.map((r) => ({ entryId: r.id, candidateId: r.registration.candidateId, attemptId: r.attempts[0]?.id ?? null }));
  },

  async list(q, ids) {
    const where: Prisma.RoundEntryWhereInput = ids ? { AND: [listWhere(q), { id: ids }] } : listWhere(q);
    const primary: Prisma.RoundEntryOrderByWithRelationInput =
      q.sort === 'fullName' || q.sort === 'createdAt'
        ? { registration: { candidate: { [q.sort]: q.dir } } }
        : { registration: { candidate: { [q.sort]: { sort: q.dir, nulls: 'last' } } } };
    const orderBy: Prisma.RoundEntryOrderByWithRelationInput[] = [
      primary,
      { registration: { candidateId: 'asc' } },
      { registration: { createdAt: 'asc' } },
      { round: { roundNumber: 'asc' } },
      { id: 'asc' },
    ];
    const [rows, total] = await prisma.$transaction([
      prisma.roundEntry.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: listInclude }),
      prisma.roundEntry.count({ where }),
    ]);
    return { rows, total };
  },

  async detail(id, skip, take) {
    const candidate = await prisma.candidate.findUnique({ where: { id }, include: personInclude });
    if (!candidate) return null;
    const [loginLogs, attempt, rows, total, history] = await prisma.$transaction([
      prisma.candidateLoginLog.findMany({ where: { candidateId: id }, orderBy: { createdAt: 'desc' }, take: 200 }),
      prisma.examAttempt.findFirst({
        where: { candidateId: id, status: { not: 'RESET' } },
        orderBy: { startedAt: 'desc' },
        select: { id: true, status: true, startedAt: true, submittedAt: true },
      }),
      prisma.activityLog.findMany({ where: { candidateId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take }),
      prisma.activityLog.count({ where: { candidateId: id } }),
      prisma.candidateStatusHistory.findMany({
        where: { candidateId: id },
        orderBy: { createdAt: 'desc' },
        include: { byAdmin: { select: { name: true } } },
      }),
    ]);
    return { candidate, loginLogs, attempt, activity: { rows, total }, history };
  },

  findById(id) {
    return prisma.candidate.findUnique({ where: { id }, include: personInclude });
  },

  async update(id, data, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        const row = await tx.candidate.update({ where: { id }, data, include: personInclude });
        await writeAudit(tx, audit);
        return row;
      });
    } catch (err) {
      if (isUnique(err)) throw conflict(PERSON_TAKEN);
      throw err;
    }
  },

  setEligible(id, eligible, audit) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.candidate.update({ where: { id }, data: { eligible }, include: personInclude });
      await writeAudit(tx, audit);
      return row;
    });
  },

  setLocationExempt(id, exempt, audit) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.candidate.update({ where: { id }, data: { locationExempt: exempt }, include: personInclude });
      await writeAudit(tx, audit);
      return row;
    });
  },

  async register(candidateId, examId, adminId, audit) {
    try {
      return await prisma.$transaction(async (tx): Promise<RegistrationRow> => {
        if (!(await lockCandidate(tx, candidateId))) throw notFound('Candidate not found');
        const { firstRoundId } = await lockUsableExam(tx, examId);
        if (await tx.examRegistration.findUnique({ where: { candidateId_examId: { candidateId, examId } }, select: { id: true } })) {
          throw conflict(ALREADY_REGISTERED);
        }
        const registrationId = await addRegistration(tx, candidateId, examId, firstRoundId, adminId);
        await writeAudit(tx, audit(registrationId));
        return tx.examRegistration.findUniqueOrThrow({ where: { id: registrationId }, select: registrationSelect });
      });
    } catch (err) {
      if (isUnique(err)) throw conflict(ALREADY_REGISTERED);
      throw err;
    }
  },

  removeRegistration(candidateId, registrationId, audit) {
    return prisma.$transaction(async (tx) => {
      if (!(await lockCandidate(tx, candidateId))) throw notFound('Candidate not found');
      const reg = await tx.examRegistration.findFirst({ where: { id: registrationId, candidateId }, select: { id: true, examId: true } });
      if (!reg) throw notFound('Registration not found');
      await tx.$queryRaw`SELECT 1 FROM exams WHERE id = ${reg.examId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM round_entries WHERE registration_id = ${reg.id}::uuid ORDER BY id FOR UPDATE`;
      if ((await tx.examAttempt.count({ where: { roundEntry: { registrationId: reg.id } } })) > 0) {
        throw conflict('This exam has already been started and cannot be removed.');
      }
      if ((await tx.examRegistration.count({ where: { candidateId } })) <= 1) {
        throw conflict('A candidate must keep at least one exam. Disable the candidate instead.');
      }
      await tx.candidateStatusHistory.deleteMany({ where: { roundEntry: { registrationId: reg.id } } });
      await tx.roundEntry.deleteMany({ where: { registrationId: reg.id } });
      await tx.examRegistration.delete({ where: { id: reg.id } });
      await writeAudit(tx, audit(reg.examId));
    });
  },

  resetAttempt(candidateId, entryId, adminId, reason, audit) {
    return prisma.$transaction(async (tx) => {
      // Candidate row first, as exam start, evaluation and decisions do, so a
      // reset racing them reads their committed state rather than a stale one.
      if (!(await lockCandidate(tx, candidateId))) throw notFound('Candidate not found');
      const owned = await tx.roundEntry.count({ where: { id: entryId, registration: { candidateId } } });
      if (owned === 0) throw notFound('Round entry not found');
      // Takes the exam FOR SHARE and this entry FOR UPDATE; refuses (409, so
      // the whole reset rolls back) when the next round was already started.
      const nextRoundEntry = await revokeNextRound(tx, entryId);
      const attempt = await tx.examAttempt.findFirst({ where: { roundEntryId: entryId, status: { not: 'RESET' } }, select: { id: true } });
      if (!attempt) throw conflict(NOTHING_TO_RESET);
      await tx.$queryRaw`SELECT id FROM exam_attempts WHERE id = ${attempt.id}::uuid FOR UPDATE`;
      const entry = await tx.roundEntry.findUniqueOrThrow({ where: { id: entryId }, select: { status: true } });
      await tx.examAttempt.update({ where: { id: attempt.id }, data: { status: 'RESET' } });
      await tx.roundEntry.update({ where: { id: entryId }, data: { status: 'NOT_STARTED' } });
      await tx.candidateStatusHistory.create({
        data: { candidateId, roundEntryId: entryId, fromStatus: entry.status, toStatus: 'NOT_STARTED', byAdminId: adminId, comment: reason },
      });
      await writeAudit(tx, audit({ attemptId: attempt.id, nextRoundEntry }));
    });
  },
};
