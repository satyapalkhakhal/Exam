// modules/candidates/candidates.repository.ts
// candidates (applications) + their logs, and the candidate accounts that own
// their email and mobile. Every write commits with its audit row. The unique
// indexes (account email/mobile, account x role) are the final arbiter of
// duplicates, so concurrent imports or edits cannot slip one past the service.
// Lock order is account row, then candidate rows (as the exam start does), so
// admin writes cannot deadlock with a start.

import type { CandidateBulkJobRoleResultDto, CandidateListQuery } from '@exam/shared';
import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { conflict } from '../../shared/errors.js';
import { writeAudit } from '../audit/index.js';
import type { CandidatesRepository } from './candidates.service.js';
import type { ExistingAccount } from './candidateImport.parser.js';

const include = { jobRole: { select: { name: true } } } as const;
const HELD = 'This person already has a candidate for this job role.';
const MOBILE_TAKEN = 'Another candidate already has this mobile number.';
const isUnique = (err: unknown): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

function listWhere(q: CandidateListQuery): Prisma.CandidateWhereInput {
  return {
    ...(q.jobRoleId ? { jobRoleId: q.jobRoleId } : {}),
    ...(q.status ? { status: q.status } : {}),
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

export const candidatesRepository: CandidatesRepository = {
  async jobRoleExists(id) {
    return (await prisma.jobRole.count({ where: { id } })) > 0;
  },

  async rolesByLowerName() {
    const roles = await prisma.jobRole.findMany({ select: { id: true, name: true } });
    return new Map(roles.map((r) => [r.name.trim().toLowerCase(), r.id]));
  },

  async existingAccounts() {
    const accounts = await prisma.candidateAccount.findMany({
      select: { id: true, email: true, mobile: true, applications: { select: { id: true, jobRoleId: true, status: true } } },
    });
    const accountsByEmail = new Map<string, ExistingAccount>();
    const mobileOwners = new Map<string, string>();
    for (const a of accounts) {
      accountsByEmail.set(a.email.toLowerCase(), {
        accountId: a.id,
        mobile: a.mobile,
        roles: new Map(a.applications.map((c) => [c.jobRoleId, { id: c.id, status: c.status }])),
      });
      if (a.mobile) mobileOwners.set(a.mobile, a.id);
    }
    return { accountsByEmail, mobileOwners };
  },

  async lastImportOf(jobRoleId, fileHash) {
    const batch = await prisma.importBatch.findFirst({
      where: { kind: 'CANDIDATES', jobRoleId, fileHash },
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
          jobRoleId: input.jobRoleId,
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
      const byEmail = new Map(accounts.map((a) => [a.email, a]));
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
              jobRoleId: r.jobRoleId,
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
        const locked = await tx.$queryRaw<{ status: string; job_role_id: string }[]>`
          SELECT status::text AS status, job_role_id::text FROM candidates WHERE id = ${u.candidateId}::uuid FOR UPDATE`;
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
        await writeAudit(tx, input.updateAudit(u, current.job_role_id));
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
        orderBy: { jobRole: { name: 'asc' } },
        select: { id: true, candidateCode: true, status: true, jobRole: { select: { id: true, name: true } } },
      }),
    ]);
    return { candidate, loginLogs, attempt, otherApplications, activity: { rows, total }, history };
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
          if ((await tx.candidate.count({ where: { accountId: account.id, jobRoleId: data.jobRoleId } })) > 0) throw conflict(HELD);
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
        if (own.jobRoleId !== undefined) {
          const held = await tx.candidate.count({ where: { accountId, jobRoleId: own.jobRoleId, NOT: { id } } });
          if (held > 0) throw conflict(HELD);
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

  bulkSetJobRole(ids, jobRoleId, audit) {
    return prisma.$transaction(async (tx) => {
      // Accounts first, then candidates, each in id order (the exam start locks account
      // then candidate too), so overlapping bulk moves and starts cannot deadlock; a start
      // or reset on one of these candidates serialises on the same row locks.
      await tx.$queryRaw`
        SELECT a.id FROM candidate_accounts a
        WHERE a.id IN (SELECT account_id FROM candidates WHERE id = ANY(${ids}::uuid[]))
        ORDER BY a.id FOR UPDATE`;
      const rows = await tx.$queryRaw<{ id: string; status: string; job_role_id: string; candidate_code: string; full_name: string }[]>`
        SELECT id::text, status::text AS status, job_role_id::text, candidate_code, full_name
        FROM candidates WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
      const found = new Map(rows.map((r) => [r.id, r]));
      const skipped: CandidateBulkJobRoleResultDto['skipped'] = [];
      let updated = 0;
      for (const id of ids) {
        const r = found.get(id);
        if (!r) {
          skipped.push({ candidateId: id, candidateCode: null, fullName: null, reason: 'NOT_FOUND' });
          continue;
        }
        let reason: CandidateBulkJobRoleResultDto['skipped'][number]['reason'] | null =
          r.status !== 'NOT_STARTED' ? 'STARTED' : r.job_role_id === jobRoleId ? 'SAME_ROLE' : null;
        if (reason === null) {
          const { accountId } = await tx.candidate.findUniqueOrThrow({ where: { id }, select: { accountId: true } });
          if ((await tx.candidate.count({ where: { accountId, jobRoleId } })) > 0) reason = 'SAME_PERSON_HAS_ROLE';
        }
        if (reason) {
          skipped.push({ candidateId: id, candidateCode: r.candidate_code, fullName: r.full_name, reason });
          continue;
        }
        await tx.candidate.update({ where: { id }, data: { jobRoleId } });
        await writeAudit(tx, audit(id, r.job_role_id));
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
      const candidate = await tx.candidate.findUniqueOrThrow({ where: { id }, select: { status: true } });
      await tx.examAttempt.update({ where: { id: attempt.id }, data: { status: 'RESET' } });
      await tx.candidate.update({ where: { id }, data: { status: 'NOT_STARTED' } });
      await tx.candidateStatusHistory.create({
        data: { candidateId: id, fromStatus: candidate.status, toStatus: 'NOT_STARTED', byAdminId: adminId, comment: reason },
      });
      await writeAudit(tx, audit);
      return true;
    });
  },
};
