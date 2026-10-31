// modules/candidateAuth/candidateAuth.service.ts
// Candidate sign-in (design §7.1), location capture (§7.2a) and the round
// cards on the candidate's dashboard (spec §5.4).
// - request-otp never says whether a candidate exists: unknown, ineligible and
//   undeliverable all return the same {sent:true}; only OTP_COOLDOWN is
//   surfaced. Delivery problems go to the audit log and the candidate's
//   activity log, where HR can see them.
// - Mobile registration (first login for candidates imported without a mobile):
//   email + roll number pick the candidate, an SMS code sent only to the typed
//   mobile proves the phone, and the mobile is linked once. The code is bound to
//   (candidate, mobile), so it cannot verify a different number. Request replies
//   are generic like request-otp; refusals go to the activity log for HR.
// - verify-otp gives OTP_INVALID for an unknown identifier, an ineligible
//   candidate and a wrong code alike.
// - A login is a refresh-token family. The family id rides in the access token
//   and is stored on every location row, so "location captured" means a GRANTED
//   LOGIN row exists for *this* login; every new login asks again.
// Dependencies are injected so the rules are unit tested without a database.

import { examAvailability, type CandidateRoundCardDto, type CandidateRoundState, type CandidateSelf } from '@exam/shared';
import { logger } from '../../infrastructure/logger/logger.js';
import { AppError, conflict, unauthorized } from '../../shared/errors.js';
import { maskMobile } from '../../shared/utils/piiMask.js';
import type { ClientInfo } from '../../shared/utils/clientInfo.js';
import type { AuditRecord } from '../audit/index.js';
import { issueRefreshToken, peekRefreshFamily, revokeRefreshToken, rotateRefreshToken, signAccess } from '../adminAuth/tokens.js';

export interface CandidateAuthRecord {
  id: string;
  candidateCode: string;
  fullName: string;
  email: string;
  mobile: string | null;
  rollNumber: string | null;
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

/** One of the candidate's round entries with its round settings and live attempt (if any). */
export interface RoundCardRow {
  entryId: string;
  jobRoleName: string;
  examName: string;
  roundNumber: number;
  roundName: string | null;
  durationMinutes: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  instructions: string;
  isOpen: boolean;
  /** The entry's non-RESET attempt status; null when the round was never started (or was reset). */
  attemptStatus: 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED' | null;
}

export interface CandidateAuthRepository {
  findByIdentifier(identifier: string): Promise<CandidateAuthRecord | null>;
  findById(id: string): Promise<CandidateAuthRecord | null>;
  linkMobile(candidateId: string, mobile: string): Promise<'linked' | 'already_linked' | 'mobile_in_use'>;
  hasGrantedLogin(candidateId: string, sessionFamily: string): Promise<boolean>;
  recordLocation(entry: LocationEntry): Promise<void>;
  recordActivity(entry: {
    candidateId: string;
    eventType: string;
    ip: string;
    userAgent: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  /**
   * The candidate's round entries in active exams (plus any entry whose attempt
   * is running, so a deactivated exam can still be resumed), ordered by job
   * profile, exam and round number.
   */
  listRoundCards(candidateId: string): Promise<RoundCardRow[]>;
}

export interface CandidateAuthDeps {
  repo: CandidateAuthRepository;
  audit: (entry: AuditRecord) => Promise<void>;
  otp: {
    issue: (p: {
      purpose: 'candidate_login' | 'candidate_mobile_link';
      subjectId: string;
      recipient: { email: string | null; mobile: string | null };
    }) => Promise<unknown>;
    verify: (p: { purpose: 'candidate_login' | 'candidate_mobile_link'; subjectId: string; code: string }) => Promise<void>;
  };
  now?: () => Date;
}

export interface CandidateSignedIn {
  candidate: CandidateSelf;
  accessToken: string;
  refreshToken: string;
}

const AUTH = 'candidate_auth';
const LINK = 'candidate_mobile_link';
// The code is issued per (candidate, mobile), so it only ever verifies the number it was sent to.
const linkSubject = (candidateId: string, mobile: string) => `${candidateId}:${mobile}`;
const sameRoll = (stored: string | null, typed: string) =>
  stored !== null && stored.trim().toLowerCase() === typed.trim().toLowerCase();
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

  type LinkInput = { email: string; rollNumber: string; mobile: string; client: ClientInfo };

  // The IP is repeated in metadata because the candidate page shows metadata, not the ip column.
  const logLink = (candidateId: string, eventType: string, client: ClientInfo, metadata: Record<string, unknown>) =>
    deps.repo.recordActivity({ candidateId, eventType, ip: client.ip, userAgent: client.userAgent, metadata: { ...metadata, ip: client.ip } });

  /** Matches only an eligible candidate whose roll number agrees; null otherwise. */
  async function findForLink(email: string, rollNumber: string): Promise<CandidateAuthRecord | null> {
    const c = await deps.repo.findByIdentifier(email);
    return c && c.eligible && sameRoll(c.rollNumber, rollNumber) ? c : null;
  }

  async function requestMobileLink(input: LinkInput): Promise<{ sent: true }> {
    const candidate = await findForLink(input.email, input.rollNumber);
    if (!candidate) return { sent: true };
    if (candidate.mobile !== null) {
      // Someone tried to register a phone on an account that already has one: HR should see it.
      await logLink(candidate.id, 'MOBILE_LINK_REFUSED', input.client, { reason: 'already_linked', mobile: maskMobile(input.mobile) });
      return { sent: true };
    }
    const holder = await deps.repo.findByIdentifier(input.mobile);
    if (holder) {
      await logLink(candidate.id, 'MOBILE_LINK_REFUSED', input.client, { reason: 'mobile_in_use', mobile: maskMobile(input.mobile) });
      return { sent: true };
    }
    try {
      await deps.otp.issue({
        purpose: LINK,
        subjectId: linkSubject(candidate.id, input.mobile),
        recipient: { email: null, mobile: input.mobile },
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'OTP_COOLDOWN') throw err;
      const reason = err instanceof AppError ? err.code : 'delivery_error';
      logger.warn('Mobile registration OTP could not be issued', { reason });
      await deps.audit({ adminId: null, action: 'CANDIDATE_OTP_FAILED', entity: LINK, entityId: candidate.id, ip: input.client.ip, metadata: { reason } });
      await logLink(candidate.id, 'OTP_DELIVERY_FAILED', input.client, { reason, purpose: LINK });
    }
    return { sent: true };
  }

  async function verifyMobileLink(input: LinkInput & { code: string }): Promise<CandidateSignedIn> {
    const candidate = await findForLink(input.email, input.rollNumber);
    if (!candidate || candidate.mobile !== null) throw invalidOtp();
    await deps.otp.verify({ purpose: LINK, subjectId: linkSubject(candidate.id, input.mobile), code: input.code });

    const outcome = await deps.repo.linkMobile(candidate.id, input.mobile);
    if (outcome === 'mobile_in_use') {
      throw conflict('This mobile number is already registered to another candidate. Please contact HR.');
    }
    if (outcome === 'already_linked') throw invalidOtp();

    const masked = maskMobile(input.mobile);
    await logLink(candidate.id, 'MOBILE_SELF_REGISTERED', input.client, { mobile: masked });
    await deps.audit({
      adminId: null,
      action: 'CANDIDATE_MOBILE_SELF_REGISTERED',
      entity: LINK,
      entityId: candidate.id,
      ip: input.client.ip,
      metadata: { mobile: masked },
    });
    const linked = { ...candidate, mobile: input.mobile };
    return mint(linked, await issueRefreshToken('candidate', linked.id));
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

  const WINDOW_STATE = { OPEN: 'READY', NOT_OPEN: 'NOT_OPEN', BEFORE_WINDOW: 'BEFORE_WINDOW', AFTER_WINDOW: 'CLOSED' } as const;

  /**
   * The dashboard's round cards. A started round shows IN_PROGRESS or (once
   * finished, whatever its marks or decision) SUBMITTED; while one round is
   * running every other shows BLOCKED_OTHER_IN_PROGRESS; otherwise the round's
   * open switch and window decide. Rounds without an entry are never listed.
   */
  async function exams(candidateId: string): Promise<CandidateRoundCardDto[]> {
    const candidate = await deps.repo.findById(candidateId);
    if (!candidate || !candidate.eligible) throw unauthorized();
    const rows = await deps.repo.listRoundCards(candidateId);
    const at = now();
    const running = rows.some((r) => r.attemptStatus === 'IN_PROGRESS');
    const stateOf = (r: RoundCardRow): CandidateRoundState => {
      if (r.attemptStatus === 'IN_PROGRESS') return 'IN_PROGRESS';
      if (r.attemptStatus !== null) return 'SUBMITTED';
      if (running) return 'BLOCKED_OTHER_IN_PROGRESS';
      return WINDOW_STATE[examAvailability(r, at)];
    };
    return rows.map((r) => ({
      entryId: r.entryId,
      jobRoleName: r.jobRoleName,
      examName: r.examName,
      roundNumber: r.roundNumber,
      roundName: r.roundName ?? '',
      durationMinutes: r.durationMinutes,
      windowStart: r.windowStart?.toISOString() ?? null,
      windowEnd: r.windowEnd?.toISOString() ?? null,
      instructions: r.instructions,
      state: stateOf(r),
    }));
  }

  return { requestOtp, verifyOtp, requestMobileLink, verifyMobileLink, refresh, logout, isActive, me, recordLocation, exams };
}

export type CandidateAuthService = ReturnType<typeof createCandidateAuthService>;
