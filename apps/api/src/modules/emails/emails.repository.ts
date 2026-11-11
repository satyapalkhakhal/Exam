// modules/emails/emails.repository.ts
// email_dispatches plus the reads the email service needs (candidates with their
// current attempt, template save info, the admin's own address). The dispatch
// inserts commit with their audit row. A dispatch is only ever moved on from
// QUEUED, so a stale job cannot overwrite a finished one.

import type { EmailDispatchListQuery } from '@exam/shared';
import { prisma } from '../../infrastructure/db/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { writeAudit } from '../audit/index.js';
import { attemptCounts } from '../exam/attemptCounts.js';
import type { DispatchRepository, EmailsRepository } from './emails.service.js';

export const emailsRepository: EmailsRepository & DispatchRepository = {
  async templateMeta(keys) {
    const rows = await prisma.systemConfig.findMany({
      where: { key: { in: keys } },
      select: { key: true, updatedAt: true, updatedBy: { select: { name: true } } },
    });
    return new Map(rows.map((r) => [r.key, { updatedAt: r.updatedAt, updatedByName: r.updatedBy?.name ?? null }]));
  },

  async firstActiveRoleName() {
    const role = await prisma.jobRole.findFirst({ where: { active: true }, orderBy: { name: 'asc' }, select: { name: true } });
    return role?.name ?? null;
  },

  async adminEmail(adminId) {
    const admin = await prisma.adminUser.findUnique({ where: { id: adminId }, select: { email: true } });
    return admin?.email ?? null;
  },

  async findCandidates(ids) {
    const rows = await prisma.candidate.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        candidateCode: true,
        fullName: true,
        email: true,
        eligible: true,
        status: true,
        result: true,
        jobRole: { select: { name: true, type: true, _count: { select: { rounds: true } } } },
        drive: { select: { round: { select: { roundNumber: true } } } },
        attempts: {
          where: { status: { not: 'RESET' } },
          take: 1,
          select: { id: true, status: true, startedAt: true, submittedAt: true, submitType: true },
        },
      },
    });
    const counts = await attemptCounts(rows.flatMap((r) => r.attempts.map((a) => a.id)));
    return rows.map((r) => {
      const a = r.attempts[0];
      return {
        id: r.id,
        candidateCode: r.candidateCode,
        fullName: r.fullName,
        email: r.email,
        eligible: r.eligible,
        status: r.status,
        result: r.result,
        jobRoleName: r.jobRole.name,
        jobProfileType: r.jobRole.type,
        roundNumber: r.jobRole._count.rounds > 1 ? r.drive.round.roundNumber : null,
        attempt: a
          ? {
              status: a.status,
              startedAt: a.startedAt,
              submittedAt: a.submittedAt,
              submitType: a.submitType,
              ...(counts.get(a.id) ?? { answeredCount: 0, questionCount: 0 }),
            }
          : null,
      };
    });
  },

  async candidateIdsWithActiveDispatch(ids, template) {
    const rows = await prisma.emailDispatch.findMany({
      where: { candidateId: { in: ids }, template, status: { in: ['QUEUED', 'SENT'] } },
      select: { candidateId: true },
      distinct: ['candidateId'],
    });
    return new Set(rows.map((r) => r.candidateId));
  },

  async createDispatches(batchId, sentById, rows, audit) {
    return prisma.$transaction(async (tx) => {
      const created = await Promise.all(
        rows.map((r) => tx.emailDispatch.create({ data: { ...r, batchId, sentById, status: 'QUEUED' }, select: { id: true } })),
      );
      await writeAudit(tx, audit);
      return created.map((c) => c.id);
    });
  },

  async failDispatches(ids, error) {
    await prisma.emailDispatch.updateMany({ where: { id: { in: ids }, status: 'QUEUED' }, data: { status: 'FAILED', error } });
  },

  async listDispatches(q: EmailDispatchListQuery) {
    const where: Prisma.EmailDispatchWhereInput = {
      ...(q.candidateId ? { candidateId: q.candidateId } : {}),
      ...(q.template ? { template: q.template } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.batchId ? { batchId: q.batchId } : {}),
    };
    const [rows, total] = await prisma.$transaction([
      prisma.emailDispatch.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          batchId: true,
          template: true,
          candidateId: true,
          toEmail: true,
          subject: true,
          status: true,
          error: true,
          createdAt: true,
          sentAt: true,
          candidate: { select: { candidateCode: true, fullName: true } },
          sentBy: { select: { name: true } },
        },
      }),
      prisma.emailDispatch.count({ where }),
    ]);
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        batchId: r.batchId,
        template: r.template,
        candidateId: r.candidateId,
        candidateCode: r.candidate.candidateCode,
        fullName: r.candidate.fullName,
        toEmail: r.toEmail,
        subject: r.subject,
        status: r.status,
        error: r.error,
        sentByName: r.sentBy.name,
        createdAt: r.createdAt,
        sentAt: r.sentAt,
      })),
    };
  },

  async findForSend(id) {
    const d = await prisma.emailDispatch.findUnique({
      where: { id },
      select: { id: true, status: true, template: true, toEmail: true, subject: true, html: true, text: true, candidate: { select: { result: true } } },
    });
    if (!d) return null;
    const { candidate, ...rest } = d;
    return { ...rest, candidateResult: candidate.result };
  },

  async markSent(id) {
    const r = await prisma.emailDispatch.updateMany({
      where: { id, status: 'QUEUED' },
      data: { status: 'SENT', sentAt: new Date(), error: null, attempts: { increment: 1 } },
    });
    return r.count > 0;
  },

  async recordFailure(id, error, final) {
    await prisma.emailDispatch.updateMany({
      where: { id, status: 'QUEUED' },
      data: { error, attempts: { increment: 1 }, ...(final ? { status: 'FAILED' as const } : {}) },
    });
  },
};
