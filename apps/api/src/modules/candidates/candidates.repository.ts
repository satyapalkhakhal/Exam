// modules/candidates/candidates.repository.ts
// candidates (applications) + their logs, and the candidate accounts that own
// their email and mobile. Every write commits with its audit row. The unique
// indexes (account email/mobile, account x drive) are the final arbiter of
// duplicates, so concurrent imports or edits cannot slip one past the service.
// "One person per round and batch" (no entries in two colleges' drives of the
// same round + batch) has no index: every write that creates or moves an entry
// checks it under the account row lock. Lock order is account row, then
// candidate rows (as the exam start does), so admin writes cannot deadlock
// with a start.

import {
  CANDIDATE_BULK_MAX,
  driveDisplayName,
  type CandidateListQuery,
  type CandidateMoveResultDto,
  type CandidateRowDto,
} from '@exam/shared';
import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { conflict } from '../../shared/errors.js';
import { writeAudit } from '../audit/index.js';
import { attemptCounts } from '../exam/attemptCounts.js';
import type { CandidatesRepository } from './candidates.service.js';
import type { ExistingAccount } from './candidateImport.parser.js';

const include = {
  jobRole: { select: { name: true, type: true } },
  drive: { select: { batch: true, roundId: true, round: { select: { roundNumber: true } }, college: { select: { shortCode: true } } } },
} as const;
/** The same select for a sibling/other entry, to build its drive display name. */
const driveNameSelect = {
  jobRole: { select: { name: true } },
  drive: { select: { batch: true, round: { select: { roundNumber: true } }, college: { select: { shortCode: true } } } },
} as const;
type DriveNamed = { jobRole: { name: string }; drive: { batch: string; round: { roundNumber: number }; college: { shortCode: string } } };
const nameOf = (c: DriveNamed): string =>
  driveDisplayName({ jobRoleName: c.jobRole.name, roundNumber: c.drive.round.roundNumber, collegeShortCode: c.drive.college.shortCode, batch: c.drive.batch });

const HELD = 'This person is already in this drive.';
const SAME_ROUND_BATCH = (s: { collegeShortCode: string; batch: string }) =>
  conflict(`This person is already in ${s.collegeShortCode}'s ${s.batch} drive for this round.`, 'SAME_ROUND_BATCH');
const MOBILE_TAKEN = 'Another candidate already has this mobile number.';
const isUnique = (err: unknown): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * The person's entry in another college's drive of the target drive's round
 * and batch (case-insensitive), ignoring `exceptCandidateId`. Call it holding
 * the account row lock so two writes for one person cannot both pass.
 */
export async function siblingEntry(
  tx: Prisma.TransactionClient,
  accountId: string,
  driveId: string,
  exceptCandidateId?: string,
): Promise<{ collegeShortCode: string; batch: string } | null> {
  const except = exceptCandidateId ? Prisma.sql`AND c.id <> ${exceptCandidateId}::uuid` : Prisma.empty;
  const rows = await tx.$queryRaw<{ short_code: string; batch: string }[]>`
    SELECT co.short_code, d.batch FROM candidates c
    JOIN drives d ON d.id = c.drive_id
    JOIN colleges co ON co.id = d.college_id
    JOIN drives t ON t.id = ${driveId}::uuid
    WHERE c.account_id = ${accountId}::uuid AND d.round_id = t.round_id AND lower(d.batch) = lower(t.batch) AND d.id <> t.id ${except}
    LIMIT 1`;
  return rows[0] ? { collegeShortCode: rows[0].short_code, batch: rows[0].batch } : null;
}

function listWhere(q: CandidateListQuery): Prisma.CandidateWhereInput {
  return {
    ...(q.jobRoleId ? { jobRoleId: q.jobRoleId } : {}),
    ...(q.driveId ? { driveId: q.driveId } : {}),
    ...(q.roundId || q.collegeId || q.batch || q.roundNumber
      ? {
          drive: {
            ...(q.roundId ? { roundId: q.roundId } : {}),
            ...(q.collegeId ? { collegeId: q.collegeId } : {}),
            ...(q.batch ? { batch: { equals: q.batch, mode: 'insensitive' as const } } : {}),
            ...(q.roundNumber ? { round: { roundNumber: q.roundNumber } } : {}),
          },
        }
      : {}),
    ...(q.jobProfileType ? { jobRole: { type: q.jobProfileType } } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.result ? { result: q.result === 'NONE' ? null : q.result } : {}),
    // gte never matches NULL, so a set minimum also drops rows without a value.
    ...(q.xMin !== undefined ? { xPercentage: { gte: q.xMin } } : {}),
    ...(q.xiiMin !== undefined ? { xiiPercentage: { gte: q.xiiMin } } : {}),
    ...(q.cpiMin !== undefined ? { majorCpi: { gte: q.cpiMin } } : {}),
    // percentage is only set while the attempt's evaluation is submitted.
    ...(q.marksPctMin !== undefined ? { attempts: { some: { status: { not: 'RESET' }, percentage: { gte: q.marksPctMin } } } } : {}),
    ...(q.search
      ? {
          OR: [
            { fullName: { contains: q.search, mode: 'insensitive' } },
            { email: { contains: q.search, mode: 'insensitive' } },
            { rollNumber: { contains: q.search, mode: 'insensitive' } },
            { candidateCode: { contains: q.search, mode: 'insensitive' } },
            { mobile: { contains: q.search } },
          ],
        }
      : {}),
  };
}

const ATTEMPT_SORT = {
  marks: Prisma.sql`a.percentage`,
  timeTaken: Prisma.sql`(a.submitted_at - a.started_at)`,
} as const;

/**
 * Sorts by a value of the current (non-RESET) attempt, which Prisma cannot order
 * by: the matching ids come from the normal where, then one SQL query orders and
 * pages them (empty values last either way, ties by id). There is at most one
 * non-RESET attempt per candidate (partial unique index).
 */
async function listByAttempt(q: CandidateListQuery, where: Prisma.CandidateWhereInput) {
  const matching = (await prisma.candidate.findMany({ where, select: { id: true } })).map((r) => r.id);
  if (matching.length === 0) return { rows: [], total: 0 };
  const expr = ATTEMPT_SORT[q.sort as keyof typeof ATTEMPT_SORT];
  const dir = q.dir === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const page = await prisma.$queryRaw<{ id: string }[]>`
    SELECT c.id::text AS id FROM candidates c
    LEFT JOIN exam_attempts a ON a.candidate_id = c.id AND a.status <> 'RESET'
    WHERE c.id = ANY(${matching}::uuid[])
    ORDER BY ${expr} ${dir} NULLS LAST, c.id ASC
    LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
  const rows = await prisma.candidate.findMany({ where: { id: { in: page.map((p) => p.id) } }, include });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { rows: page.flatMap((p) => byId.get(p.id) ?? []), total: matching.length };
}

export const candidatesRepository: CandidatesRepository = {
  async findDrive(id) {
    const d = await prisma.drive.findUnique({ where: { id }, select: { id: true, roundId: true, active: true, round: { select: { jobRoleId: true } } } });
    return d ? { id: d.id, roundId: d.roundId, active: d.active, jobRoleId: d.round.jobRoleId } : null;
  },

  async existingAccounts(driveId) {
    const target = await prisma.drive.findUniqueOrThrow({ where: { id: driveId }, select: { roundId: true, batch: true } });
    const accounts = await prisma.candidateAccount.findMany({
      select: {
        id: true,
        email: true,
        mobile: true,
        applications: {
          select: { id: true, driveId: true, status: true, drive: { select: { roundId: true, batch: true, college: { select: { shortCode: true } } } } },
        },
      },
    });
    const accountsByEmail = new Map<string, ExistingAccount>();
    const mobileOwners = new Map<string, string>();
    for (const a of accounts) {
      const sibling = a.applications.find(
        (c) => c.driveId !== driveId && c.drive.roundId === target.roundId && c.drive.batch.toLowerCase() === target.batch.toLowerCase(),
      );
      accountsByEmail.set(a.email.toLowerCase(), {
        accountId: a.id,
        mobile: a.mobile,
        entries: new Map(a.applications.map((c) => [c.driveId, { id: c.id, status: c.status }])),
        sibling: sibling ? { collegeShortCode: sibling.drive.college.shortCode, batch: sibling.drive.batch } : null,
      });
      if (a.mobile) mobileOwners.set(a.mobile, a.id);
    }
    return { accountsByEmail, mobileOwners };
  },

  async lastImportOf(driveId, fileHash) {
    const batch = await prisma.importBatch.findFirst({
      where: { kind: 'CANDIDATES', driveId, fileHash },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return batch?.createdAt ?? null;
  },

  confirmImport(input) {
    return prisma.$transaction(async (tx) => {
      const batch = await tx.importBatch.create({
        data: {
          kind: 'CANDIDATES',
          driveId: input.driveId,
          fileName: input.fileName,
          fileHash: input.fileHash,
          uploadedById: input.uploadedById,
          total: input.total,
          errors: input.errors as Prisma.InputJsonValue,
        },
      });
      // Accounts first. skipDuplicates makes this race-safe: an email that already has an
      // account, or a mobile another account took since the preview, is simply not created;
      // such a row finds no account below and is skipped.
      const firstByEmail = new Map<string, (typeof input.rows)[number]>();
      for (const r of input.rows) if (!firstByEmail.has(r.email)) firstByEmail.set(r.email, r);
      await tx.candidateAccount.createMany({
        data: [...firstByEmail.values()].map((r) => ({ email: r.email, mobile: r.mobile })),
        skipDuplicates: true,
      });
      const accounts = await tx.candidateAccount.findMany({
        where: { email: { in: [...firstByEmail.keys()] } },
        select: { id: true, email: true, mobile: true },
      });
      // Account rows locked in id order, then the same-round-and-batch rule: a
      // concurrent import of the same person into another college's drive of
      // this round either committed first (seen here, row skipped) or waits.
      const accountIds = accounts.map((a) => a.id);
      if (accountIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM candidate_accounts WHERE id = ANY(${accountIds}::uuid[]) ORDER BY id FOR UPDATE`;
      }
      const blocked = new Set<string>();
      for (const a of accounts) if (await siblingEntry(tx, a.id, input.driveId)) blocked.add(a.id);
      const byEmail = new Map(accounts.filter((a) => !blocked.has(a.id)).map((a) => [a.email, a]));
      const { count } = await tx.candidate.createMany({
        data: input.rows.flatMap((r) => {
          const account = byEmail.get(r.email);
          if (!account) return [];
          // A row that tried a different mobile than the one the account holds keeps the account's.
          return [
            {
              accountId: account.id,
              candidateCode: r.candidateCode,
              fullName: r.fullName,
              email: account.email,
              mobile: account.mobile,
              rollNumber: r.rollNumber,
              xPercentage: r.xPercentage,
              xiiPercentage: r.xiiPercentage,
              majorCpi: r.majorCpi,
              discipline: r.discipline,
              programme: r.programme,
              extra: r.extra as Prisma.InputJsonValue,
              jobRoleId: input.jobRoleId,
              driveId: input.driveId,
              importBatchId: batch.id,
            },
          ];
        }),
        skipDuplicates: true,
      });
      // Updates re-check each candidate under its row lock (ids sorted, so concurrent
      // imports lock in the same order): one that started or got a clashing mobile since
      // the preview is skipped, not overwritten. Blank file cells (null) keep stored values.
      let updated = 0;
      for (const u of [...input.updates].sort((a, b) => a.candidateId.localeCompare(b.candidateId))) {
        const owner = await tx.candidate.findUnique({ where: { id: u.candidateId }, select: { accountId: true } });
        if (!owner) continue;
        await tx.$queryRaw`SELECT id FROM candidate_accounts WHERE id = ${owner.accountId}::uuid FOR UPDATE`;
        const locked = await tx.$queryRaw<{ status: string }[]>`
          SELECT status::text AS status FROM candidates WHERE id = ${u.candidateId}::uuid FOR UPDATE`;
        const current = locked[0];
        if (!current || current.status !== 'NOT_STARTED') continue;
        if (u.mobile !== null) {
          const clash = await tx.candidateAccount.findFirst({ where: { mobile: u.mobile, NOT: { id: owner.accountId } }, select: { id: true } });
          if (clash) continue;
          await tx.candidateAccount.update({ where: { id: owner.accountId }, data: { mobile: u.mobile } });
          await tx.candidate.updateMany({ where: { accountId: owner.accountId }, data: { mobile: u.mobile } });
        }
        const data: Prisma.CandidateUpdateInput = {};
        if (u.fullName !== null) data.fullName = u.fullName;
        if (u.rollNumber !== null) data.rollNumber = u.rollNumber;
        if (u.xPercentage !== null) data.xPercentage = u.xPercentage;
        if (u.xiiPercentage !== null) data.xiiPercentage = u.xiiPercentage;
        if (u.majorCpi !== null) data.majorCpi = u.majorCpi;
        if (u.discipline !== null) data.discipline = u.discipline;
        if (u.programme !== null) data.programme = u.programme;
        await tx.candidate.update({ where: { id: u.candidateId }, data });
        await writeAudit(tx, input.updateAudit(u));
        updated += 1;
      }
      await tx.importBatch.update({ where: { id: batch.id }, data: { imported: count, skipped: input.total - count - updated } });
      await writeAudit(tx, input.audit({ imported: count, updated }));
      return { imported: count, updated };
    });
  },

  async possiblyFlaggedIds(q) {
    // Every review flag needs integrity events or an exam-start location row.
    const rows = await prisma.candidate.findMany({
      where: { AND: [listWhere(q), { OR: [{ activityLogs: { some: {} } }, { loginLogs: { some: { stage: 'EXAM_START' } } }] }] },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  },

  async list(q, ids) {
    const where: Prisma.CandidateWhereInput = ids ? { AND: [listWhere(q), { id: ids }] } : listWhere(q);
    if (q.sort === 'timeTaken' || q.sort === 'marks') return listByAttempt(q, where);
    const orderBy: Prisma.CandidateOrderByWithRelationInput[] = [
      { [q.sort]: { sort: q.dir, nulls: 'last' } } as Prisma.CandidateOrderByWithRelationInput,
      { id: 'asc' },
    ];
    if (q.sort === 'fullName' || q.sort === 'createdAt') orderBy[0] = { [q.sort]: q.dir };
    const [rows, total] = await prisma.$transaction([
      prisma.candidate.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include }),
      prisma.candidate.count({ where }),
    ]);
    return { rows, total };
  },

  async listExtras(rows) {
    if (rows.length === 0) return { exams: new Map(), others: new Map() };
    const ids = rows.map((r) => r.id);
    const [attempts, siblings] = await Promise.all([
      prisma.examAttempt.findMany({
        where: { candidateId: { in: ids }, status: { not: 'RESET' } },
        select: {
          id: true, candidateId: true, startedAt: true, submittedAt: true, totalMarks: true, maxMarks: true, percentage: true,
          evaluation: { select: { status: true } },
        },
      }),
      prisma.candidate.findMany({
        where: { accountId: { in: [...new Set(rows.map((r) => r.accountId))] } },
        orderBy: [{ jobRole: { name: 'asc' } }, { drive: { round: { roundNumber: 'asc' } } }, { id: 'asc' }],
        select: { id: true, accountId: true, status: true, result: true, ...driveNameSelect },
      }),
    ]);
    const counts = await attemptCounts(attempts.map((a) => a.id));
    const exams = new Map(
      attempts.map((a) => [
        a.candidateId,
        { ...a, evaluated: a.evaluation?.status === 'SUBMITTED', ...(counts.get(a.id) ?? { answeredCount: 0, questionCount: 0 }) },
      ]),
    );
    const others = new Map<string, { id: string; driveDisplayName: string; status: CandidateRowDto['status']; result: CandidateRowDto['result'] }[]>();
    for (const c of siblings) {
      const list = others.get(c.accountId) ?? [];
      list.push({ id: c.id, driveDisplayName: nameOf(c), status: c.status, result: c.result });
      others.set(c.accountId, list);
    }
    return { exams, others };
  },

  async matchingIds(q, ids) {
    const where: Prisma.CandidateWhereInput = ids ? { AND: [listWhere(q), { id: ids }] } : listWhere(q);
    const total = await prisma.candidate.count({ where });
    if (total > CANDIDATE_BULK_MAX) return { total, rows: [] };
    const rows = await prisma.candidate.findMany({ where, select: { id: true, driveId: true }, orderBy: { id: 'asc' } });
    return { total, rows };
  },

  async detail(id, skip, take) {
    const candidate = await prisma.candidate.findUnique({ where: { id }, include });
    if (!candidate) return null;
    const [loginLogs, attempt, rows, total, history, otherApplications] = await prisma.$transaction([
      prisma.candidateLoginLog.findMany({ where: { candidateId: id }, orderBy: { createdAt: 'desc' }, take: 200 }),
      prisma.examAttempt.findFirst({
        where: { candidateId: id, status: { not: 'RESET' } },
        select: { id: true, status: true, startedAt: true, submittedAt: true },
      }),
      prisma.activityLog.findMany({ where: { candidateId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take }),
      prisma.activityLog.count({ where: { candidateId: id } }),
      prisma.candidateStatusHistory.findMany({
        where: { candidateId: id },
        orderBy: { createdAt: 'desc' },
        include: { byAdmin: { select: { name: true } } },
      }),
      prisma.candidate.findMany({
        where: { accountId: candidate.accountId, id: { not: id } },
        orderBy: [{ jobRole: { name: 'asc' } }, { drive: { round: { roundNumber: 'asc' } } }, { id: 'asc' }],
        select: {
          id: true, candidateCode: true, status: true, result: true,
          jobRole: { select: { id: true, name: true } },
          drive: driveNameSelect.drive,
        },
      }),
    ]);
    return {
      candidate,
      loginLogs,
      attempt,
      otherApplications: otherApplications.map(({ drive, ...o }) => ({ ...o, driveDisplayName: nameOf({ jobRole: o.jobRole, drive }) })),
      activity: { rows, total },
      history,
    };
  },

  findById(id) {
    return prisma.candidate.findUnique({ where: { id }, include });
  },

  async create(data, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        const mobile = data.mobile ?? null;
        let account = await tx.candidateAccount.findUnique({ where: { email: data.email } });
        if (account) {
          await tx.$queryRaw`SELECT id FROM candidate_accounts WHERE id = ${account.id}::uuid FOR UPDATE`;
          if ((await tx.candidate.count({ where: { accountId: account.id, driveId: data.driveId } })) > 0) throw conflict(HELD);
          const sibling = await siblingEntry(tx, account.id, data.driveId);
          if (sibling) throw SAME_ROUND_BATCH(sibling);
          if (mobile !== null && account.mobile !== null && account.mobile !== mobile) {
            throw conflict('This email is already registered with a different mobile number.');
          }
          if (mobile !== null && account.mobile === null) {
            if (await tx.candidateAccount.findFirst({ where: { mobile }, select: { id: true } })) throw conflict(MOBILE_TAKEN);
            account = await tx.candidateAccount.update({ where: { id: account.id }, data: { mobile } });
            await tx.candidate.updateMany({ where: { accountId: account.id }, data: { mobile } });
          }
        } else {
          account = await tx.candidateAccount.create({ data: { email: data.email, mobile } });
        }
        const row = await tx.candidate.create({
          data: {
            accountId: account.id,
            candidateCode: data.candidateCode,
            fullName: data.fullName,
            email: account.email,
            mobile: account.mobile,
            rollNumber: data.rollNumber ?? null,
            xPercentage: data.xPercentage ?? null,
            xiiPercentage: data.xiiPercentage ?? null,
            majorCpi: data.majorCpi ?? null,
            discipline: data.discipline ?? null,
            programme: data.programme ?? null,
            jobRoleId: data.jobRoleId,
            driveId: data.driveId,
          },
          include,
        });
        await writeAudit(tx, audit(row.id));
        return row;
      });
    } catch (err) {
      if (isUnique(err)) throw conflict('Another candidate already has this email or mobile.');
      throw err;
    }
  },

  async update(id, data, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        const { email, mobile, ...own } = data;
        const current = await tx.candidate.findUniqueOrThrow({ where: { id }, select: { accountId: true } });
        const accountId = current.accountId;
        await tx.$queryRaw`SELECT id FROM candidate_accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
        // Email and mobile are the account's: change them there, then refresh every application's copy.
        if (email !== undefined || mobile !== undefined) {
          const account = await tx.candidateAccount.update({
            where: { id: accountId },
            data: { ...(email !== undefined ? { email } : {}), ...(mobile !== undefined ? { mobile } : {}) },
          });
          await tx.candidate.updateMany({ where: { accountId }, data: { email: account.email, mobile: account.mobile } });
        }
        if (own.driveId !== undefined) {
          const held = await tx.candidate.count({ where: { accountId, driveId: own.driveId, NOT: { id } } });
          if (held > 0) throw conflict(HELD);
          const sibling = await siblingEntry(tx, accountId, own.driveId, id);
          if (sibling) throw SAME_ROUND_BATCH(sibling);
        }
        const row = await tx.candidate.update({ where: { id }, data: own, include });
        await writeAudit(tx, audit);
        return row;
      });
    } catch (err) {
      if (isUnique(err)) throw conflict('Another candidate already has this email or mobile.');
      throw err;
    }
  },

  moveToDrive(ids, target, audit) {
    return prisma.$transaction(async (tx) => {
      // Accounts first, then candidates, each in id order (the exam start locks account
      // then candidate too), so overlapping moves and starts cannot deadlock; a start
      // or reset on one of these candidates serialises on the same row locks.
      await tx.$queryRaw`
        SELECT a.id FROM candidate_accounts a
        WHERE a.id IN (SELECT account_id FROM candidates WHERE id = ANY(${ids}::uuid[]))
        ORDER BY a.id FOR UPDATE`;
      const rows = await tx.$queryRaw<{ id: string; account_id: string; status: string; drive_id: string; round_id: string; candidate_code: string; full_name: string }[]>`
        SELECT c.id::text, c.account_id::text, c.status::text AS status, c.drive_id::text, d.round_id::text, c.candidate_code, c.full_name
        FROM candidates c JOIN drives d ON d.id = c.drive_id
        WHERE c.id = ANY(${ids}::uuid[]) ORDER BY c.id FOR UPDATE OF c`;
      const found = new Map(rows.map((r) => [r.id, r]));
      const skipped: CandidateMoveResultDto['skipped'] = [];
      let updated = 0;
      for (const id of ids) {
        const r = found.get(id);
        if (!r) {
          skipped.push({ candidateId: id, candidateCode: null, fullName: null, reason: 'NOT_FOUND' });
          continue;
        }
        let reason: CandidateMoveResultDto['skipped'][number]['reason'] | null = null;
        if (r.drive_id === target.id) reason = 'SAME_DRIVE';
        else if (r.round_id !== target.roundId && r.status !== 'NOT_STARTED') reason = 'STARTED';
        else if ((await tx.candidate.count({ where: { accountId: r.account_id, driveId: target.id } })) > 0) reason = 'SAME_DRIVE';
        else if (await siblingEntry(tx, r.account_id, target.id, id)) reason = 'SAME_ROUND_BATCH';
        if (reason) {
          skipped.push({ candidateId: id, candidateCode: r.candidate_code, fullName: r.full_name, reason });
          continue;
        }
        await tx.candidate.update({ where: { id }, data: { driveId: target.id, jobRoleId: target.jobRoleId } });
        await writeAudit(tx, audit(id, r.drive_id));
        updated += 1;
      }
      return { updated, skipped };
    });
  },

  setEligible(id, eligible, audit) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.candidate.update({ where: { id }, data: { eligible }, include });
      await writeAudit(tx, audit);
      return row;
    });
  },

  setLocationExempt(id, exempt, audit) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.candidate.update({ where: { id }, data: { locationExempt: exempt }, include });
      await writeAudit(tx, audit);
      return row;
    });
  },

  resetAttempt(id, adminId, reason, audit) {
    return prisma.$transaction(async (tx) => {
      // Candidate row first, as evaluation submit/reopen and decisions do, so a
      // reset racing them reads their committed status rather than a stale one.
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${id}::uuid FOR UPDATE`;
      const attempt = await tx.examAttempt.findFirst({ where: { candidateId: id, status: { not: 'RESET' } }, select: { id: true } });
      if (!attempt) return false;
      const candidate = await tx.candidate.findUniqueOrThrow({ where: { id }, select: { status: true, result: true } });
      await tx.examAttempt.update({ where: { id: attempt.id }, data: { status: 'RESET' } });
      // Back to not started, so HR's result (if any) no longer applies.
      await tx.candidate.update({ where: { id }, data: { status: 'NOT_STARTED', result: null, resultAt: null, resultById: null } });
      await tx.candidateStatusHistory.create({
        data: { candidateId: id, fromStatus: candidate.status, toStatus: 'NOT_STARTED', fromResult: candidate.result, toResult: null, byAdminId: adminId, comment: reason },
      });
      await writeAudit(tx, audit);
      return true;
    });
  },
};
