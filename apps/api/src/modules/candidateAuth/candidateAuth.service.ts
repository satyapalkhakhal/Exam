// modules/candidateAuth/candidateAuth.service.ts
// Candidate sign-in (design §7.1) and location capture (§7.2a).
// - request-otp never says whether a candidate exists: unknown, ineligible and
//   undeliverable all return the same {sent:true}; only OTP_COOLDOWN is
//   surfaced. Delivery problems go to the audit log and the candidate's
//   activity log, where HR can see them.
// - verify-otp gives OTP_INVALID for an unknown identifier, an ineligible
//   candidate and a wrong code alike.
// - A login is a refresh-token family. The family id rides in the access token
//   and is stored on every location row, so "location captured" means a GRANTED
//   LOGIN row exists for *this* login; every new login asks again.
// Dependencies are injected so the rules are unit tested without a database.

import type { CandidateSelf } from '@exam/shared';
import { logger } from '../../infrastructure/logger/logger.js';
import { AppError, unauthorized } from '../../shared/errors.js';
import type { ClientInfo } from '../../shared/utils/clientInfo.js';
import type { AuditRecord } from '../audit/index.js';
import { issueRefreshToken, peekRefreshFamily, revokeRefreshToken, rotateRefreshToken, signAccess } from '../adminAuth/tokens.js';

export interface CandidateAuthRecord {
  id: string;
  candidateCode: string;
  fullName: string;
  email: string;
  mobile: string | null;
  status: string;
  eligible: boolean;
  locationExempt: boolean;
  jobRole: { id: string; name: string };
}

export interface LocationEntry {
  candidateId: string;
  sessionFamily: string;
  stage: 'LOGIN' | 'EXAM_START';
  permission: 'GRANTED' | 'DENIED' | 'UNAVAILABLE' | 'TIMEOUT' | 'UNSUPPORTED';
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  eventType: string;
  client: ClientInfo;
}

export interface ExamSettingRow {
  durationMinutes: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  instructions: string;
  isOpen: boolean;
}

export interface CandidateAuthRepository {
  findByIdentifier(identifier: string): Promise<CandidateAuthRecord | null>;
  findById(id: string): Promise<CandidateAuthRecord | null>;
  hasGrantedLogin(candidateId: string, sessionFamily: string): Promise<boolean>;
  recordLocation(entry: LocationEntry): Promise<void>;
  recordActivity(entry: {
    candidateId: string;
    eventType: string;
    ip: string;
    userAgent: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  findExamSetting(jobRoleId: string): Promise<ExamSettingRow | null>;
}

export interface CandidateAuthDeps {
  repo: CandidateAuthRepository;
  audit: (entry: AuditRecord) => Promise<void>;
  otp: {
    issue: (p: {
      purpose: 'candidate_login';
      subjectId: string;
      recipient: { email: string; mobile: string | null };
    }) => Promise<unknown>;
    verify: (p: { purpose: 'candidate_login'; subjectId: string; code: string }) => Promise<void>;
  };
  now?: () => Date;
}

export interface CandidateSignedIn {
  candidate: CandidateSelf;
  accessToken: string;
  refreshToken: string;
}

const AUTH = 'candidate_auth';
const invalidOtp = () => new AppError(400, 'OTP_INVALID', 'Incorrect code.');

const EVENT_BY_PERMISSION: Record<LocationEntry['permission'], string> = {
  GRANTED: 'LOCATION_CAPTURED',
  DENIED: 'LOCATION_DENIED',
  UNAVAILABLE: 'LOCATION_UNAVAILABLE',
  UNSUPPORTED: 'LOCATION_UNAVAILABLE',
  TIMEOUT: 'LOCATION_TIMEOUT',
};

export function createCandidateAuthService(deps: CandidateAuthDeps) {
  const now = deps.now ?? (() => new Date());

  const toSelf = (c: CandidateAuthRecord, locationCaptured: boolean): CandidateSelf => ({
    id: c.id,
    candidateCode: c.candidateCode,
    fullName: c.fullName,
    email: c.email,
    jobRole: c.jobRole,
    status: c.status,
    locationCaptured,
    locationExempt: c.locationExempt,
  });

  async function requestOtp(input: { identifier: string; client: ClientInfo }): Promise<{ sent: true }> {
    const candidate = await deps.repo.findByIdentifier(input.identifier);
    if (!candidate || !candidate.eligible) return { sent: true };
    try {
      await deps.otp.issue({
        purpose: 'candidate_login',
        subjectId: candidate.id,
        recipient: { email: candidate.email, mobile: candidate.mobile },
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'OTP_COOLDOWN') throw err;
      const reason = err instanceof AppError ? err.code : 'delivery_error';
      logger.warn('Candidate OTP could not be issued', { reason });
      await deps.audit({
        adminId: null,
        action: 'CANDIDATE_OTP_FAILED',
        entity: AUTH,
        entityId: candidate.id,
        ip: input.client.ip,
        metadata: { reason },
      });
      await deps.repo.recordActivity({
        candidateId: candidate.id,
        eventType: 'OTP_DELIVERY_FAILED',
        ip: input.client.ip,
        userAgent: input.client.userAgent,
        metadata: { reason },
      });
    }
    return { sent: true };
  }

  async function mint(candidate: CandidateAuthRecord, refreshToken: string): Promise<CandidateSignedIn> {
    const family = await peekRefreshFamily('candidate', refreshToken);
    if (!family) throw unauthorized();
    return {
      candidate: toSelf(candidate, await deps.repo.hasGrantedLogin(candidate.id, family)),
      accessToken: signAccess('candidate', { sub: candidate.id, fam: family }),
      refreshToken,
    };
  }

  async function verifyOtp(input: { identifier: string; code: string; client: ClientInfo }): Promise<CandidateSignedIn> {
    const candidate = await deps.repo.findByIdentifier(input.identifier);
    if (!candidate || !candidate.eligible) throw invalidOtp();
    await deps.otp.verify({ purpose: 'candidate_login', subjectId: candidate.id, code: input.code });
    await deps.repo.recordActivity({
      candidateId: candidate.id,
      eventType: 'OTP_VERIFIED',
      ip: input.client.ip,
      userAgent: input.client.userAgent,
    });
    return mint(candidate, await issueRefreshToken('candidate', candidate.id));
  }

  async function refresh(refreshToken: string | undefined): Promise<CandidateSignedIn> {
    if (!refreshToken) throw unauthorized();
    const rotated = await rotateRefreshToken('candidate', refreshToken);
    const candidate = await deps.repo.findById(rotated.subjectId);
    if (!candidate || !candidate.eligible) {
      await revokeRefreshToken('candidate', rotated.token);
      throw unauthorized();
    }
    return mint(candidate, rotated.token);
  }

  async function logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) await revokeRefreshToken('candidate', refreshToken);
  }

  /** Used by the auth middleware: only an eligible candidate keeps access. */
  async function isActive(candidateId: string): Promise<boolean> {
    const c = await deps.repo.findById(candidateId);
    return !!c && c.eligible;
  }

  async function me(candidateId: string, sessionFamily: string): Promise<{ candidate: CandidateSelf }> {
    const candidate = await deps.repo.findById(candidateId);
    if (!candidate || !candidate.eligible) throw unauthorized();
    return { candidate: toSelf(candidate, await deps.repo.hasGrantedLogin(candidateId, sessionFamily)) };
  }

  async function recordLocation(
    auth: { id: string; sessionFamily: string },
    input: {
      stage: LocationEntry['stage'];
      permission: LocationEntry['permission'];
      latitude?: number;
      longitude?: number;
      accuracyM?: number;
    },
    client: ClientInfo,
  ) {
    const granted = input.permission === 'GRANTED';
    await deps.repo.recordLocation({
      candidateId: auth.id,
      sessionFamily: auth.sessionFamily,
      stage: input.stage,
      permission: input.permission,
      latitude: granted ? (input.latitude ?? null) : null,
      longitude: granted ? (input.longitude ?? null) : null,
      accuracyM: granted ? (input.accuracyM ?? null) : null,
      eventType: EVENT_BY_PERMISSION[input.permission],
      client,
    });
    return {
      locationCaptured: await deps.repo.hasGrantedLogin(auth.id, auth.sessionFamily),
      ip: client.ip,
      browser: client.browser,
      os: client.os,
      deviceType: client.deviceType,
    };
  }

  async function examInfo(candidateId: string) {
    const candidate = await deps.repo.findById(candidateId);
    if (!candidate || !candidate.eligible) throw unauthorized();
    const s = await deps.repo.findExamSetting(candidate.jobRole.id);
    return {
      durationMinutes: s?.durationMinutes ?? 60,
      windowStart: s?.windowStart?.toISOString() ?? null,
      windowEnd: s?.windowEnd?.toISOString() ?? null,
      instructions: s?.instructions ?? '',
      isOpen: s?.isOpen ?? false,
      serverNow: now().toISOString(),
    };
  }

  return { requestOtp, verifyOtp, refresh, logout, isActive, me, recordLocation, examInfo };
}

export type CandidateAuthService = ReturnType<typeof createCandidateAuthService>;
