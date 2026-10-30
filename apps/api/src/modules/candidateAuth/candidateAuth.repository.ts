// modules/candidateAuth/candidateAuth.repository.ts
// Candidate reads and the login-log/activity writes for sign-in and location.
// Every method that reads a candidate's own data takes the candidate id from
// the verified token, never from the URL. Location rows are written together
// with their activity event so the two cannot drift apart.

import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { CandidateAuthRepository } from './candidateAuth.service.js';

const selfSelect = {
  id: true,
  candidateCode: true,
  fullName: true,
  email: true,
  mobile: true,
  rollNumber: true,
  status: true,
  eligible: true,
  locationExempt: true,
  jobRole: { select: { id: true, name: true } },
} as const;

export const candidateAuthRepository: CandidateAuthRepository = {
  findByIdentifier(identifier) {
    const where = identifier.includes('@') ? { email: identifier } : { mobile: identifier };
    return prisma.candidate.findUnique({ where, select: selfSelect });
  },

  findById(id) {
    return prisma.candidate.findUnique({ where: { id }, select: selfSelect });
  },

  // Link-once: the update only matches while the slot is empty, so two racing
  // registrations cannot both win; the unique index catches a mobile taken meanwhile.
  async linkMobile(candidateId, mobile) {
    try {
      const r = await prisma.candidate.updateMany({ where: { id: candidateId, mobile: null }, data: { mobile } });
      return r.count === 1 ? 'linked' : 'already_linked';
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return 'mobile_in_use';
      throw err;
    }
  },

  async hasGrantedLogin(candidateId, sessionFamily) {
    const row = await prisma.candidateLoginLog.findFirst({
      where: { candidateId, sessionFamily, stage: 'LOGIN', permission: 'GRANTED' },
      select: { id: true },
    });
    return row !== null;
  },

  async recordLocation(entry) {
    await prisma.$transaction([
      prisma.candidateLoginLog.create({
        data: {
          candidateId: entry.candidateId,
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
          candidateId: entry.candidateId,
          eventType: entry.eventType,
          ip: entry.client.ip,
          userAgent: entry.client.userAgent,
          metadata: { stage: entry.stage, permission: entry.permission } as Prisma.InputJsonValue,
        },
      }),
    ]);
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

  findExamSetting(jobRoleId) {
    return prisma.examSetting.findUnique({
      where: { jobRoleId },
      select: { durationMinutes: true, windowStart: true, windowEnd: true, instructions: true, isOpen: true },
    });
  },
};
