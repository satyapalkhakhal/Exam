// modules/candidateAuth/candidateAuth.repository.ts
// Candidate reads and the login-log/activity writes for sign-in and location.
// Every method that reads a candidate's own data takes the candidate id from
// the verified token, never from the URL. Location rows are written together
// with their activity event so the two cannot drift apart.

import { prisma } from '../../infrastructure/db/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { CandidateAuthRepository } from './candidateAuth.service.js';

const selfSelect = {
  id: true,
  candidateCode: true,
  fullName: true,
  email: true,
  mobile: true,
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
