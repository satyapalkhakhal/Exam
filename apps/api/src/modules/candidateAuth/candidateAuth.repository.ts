// modules/candidateAuth/candidateAuth.repository.ts
// Candidate-account reads and the login-log/activity writes for sign-in and location.
// Every method that reads a candidate's own data takes the account id from
// the verified token, never from the URL. Location rows are written together
// with their activity event so the two cannot drift apart.

import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { CandidateAuthRepository } from './candidateAuth.service.js';

const accountSelect = {
  id: true,
  email: true,
  mobile: true,
  applications: {
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    select: { id: true, fullName: true, rollNumber: true, eligible: true, locationExempt: true },
  },
} satisfies Prisma.CandidateAccountSelect;

export const candidateAuthRepository: CandidateAuthRepository = {
  findByIdentifier(identifier) {
    const where = identifier.includes('@') ? { email: identifier } : { mobile: identifier };
    return prisma.candidateAccount.findUnique({ where, select: accountSelect });
  },

  findById(id) {
    return prisma.candidateAccount.findUnique({ where: { id }, select: accountSelect });
  },

  // Link-once: the update only matches while the slot is empty, so two racing
  // registrations cannot both win; the unique index catches a mobile taken meanwhile.
  // The applications carry a copy of the mobile, set in the same transaction.
  async linkMobile(accountId, mobile) {
    try {
      return await prisma.$transaction(async (tx) => {
        const r = await tx.candidateAccount.updateMany({ where: { id: accountId, mobile: null }, data: { mobile } });
        if (r.count !== 1) return 'already_linked' as const;
        await tx.candidate.updateMany({ where: { accountId }, data: { mobile } });
        return 'linked' as const;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return 'mobile_in_use';
      throw err;
    }
  },

  async hasGrantedLogin(accountId, sessionFamily) {
    const row = await prisma.candidateLoginLog.findFirst({
      where: { candidate: { accountId }, sessionFamily, stage: 'LOGIN', permission: 'GRANTED' },
      select: { id: true },
    });
    return row !== null;
  },

  async recordLocation(entry) {
    await prisma.$transaction(
      entry.candidateIds.flatMap((candidateId) => [
        prisma.candidateLoginLog.create({
          data: {
            candidateId,
            stage: entry.stage,
            permission: entry.permission,
            latitude: entry.latitude,
            longitude: entry.longitude,
            accuracyM: entry.accuracyM === null ? null : Math.round(entry.accuracyM),
            ip: entry.client.ip,
            userAgent: entry.client.userAgent,
            browser: entry.client.browser,
            os: entry.client.os,
            deviceType: entry.client.deviceType,
            sessionFamily: entry.sessionFamily,
          },
        }),
        prisma.activityLog.create({
          data: {
            candidateId,
            eventType: entry.eventType,
            ip: entry.client.ip,
            userAgent: entry.client.userAgent,
            metadata: { stage: entry.stage, permission: entry.permission } as Prisma.InputJsonValue,
          },
        }),
      ]),
    );
  },

  async recordActivity(entry) {
    await prisma.activityLog.create({
      data: {
        candidateId: entry.candidateId,
        eventType: entry.eventType,
        ip: entry.ip,
        userAgent: entry.userAgent,
        metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  },
};
