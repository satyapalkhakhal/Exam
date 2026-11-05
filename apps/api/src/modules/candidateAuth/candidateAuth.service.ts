// modules/candidateAuth/candidateAuth.service.ts
// Candidate sign-in (design §7.1) and location capture (§7.2a). The person who
// signs in is a candidate account (docs/multi-exam.md): tokens, OTP subjects and
// refresh subjects are account ids; an account holds one application per job
// role and may sign in while at least one of them is eligible.
// - request-otp never says whether a candidate exists: unknown, ineligible and
//   undeliverable all return the same {sent:true}; only OTP_COOLDOWN is
//   surfaced. Delivery problems go to the audit log and the candidate's
//   activity log, where HR can see them.
// - Mobile registration (first login for candidates imported without a mobile):
//   email + roll number pick the account (via one of its eligible applications),
//   an SMS code sent only to the typed mobile proves the phone, and the mobile is
//   linked once to the account and all its applications. The code is bound to
//   (account, mobile), so it cannot verify a different number. Request replies
//   are generic like request-otp; refusals go to the activity log for HR.
// - verify-otp gives OTP_INVALID for an unknown identifier, an ineligible
//   candidate and a wrong code alike.
// - A login is a refresh-token family. The family id rides in the access token
//   and is stored on every location row, so "location captured" means a GRANTED
//   LOGIN row (for any of the account's applications) exists for *this* login;
//   every new login asks again. A LOGIN location is stored once per eligible
//   application so the per-application review flags work unchanged.
// Dependencies are injected so the rules are unit tested without a database.

import type { CandidateSelf } from '@exam/shared';
import { logger } from '../../infrastructure/logger/logger.js';
import { AppError, badRequest, conflict, unauthorized } from '../../shared/errors.js';
import { maskEmail, maskMobile } from '../../shared/utils/piiMask.js';
import type { ClientInfo } from '../../shared/utils/clientInfo.js';
import type { AuditRecord } from '../audit/index.js';
import { issueRefreshToken, peekRefreshFamily, revokeRefreshToken, rotateRefreshToken, signAccess } from '../adminAuth/tokens.js';

export interface AccountApplication {
  id: string;
  fullName: string;
  rollNumber: string | null;
  eligible: boolean;
  locationExempt: boolean;
}

export interface CandidateAccountRecord {
  id: string;
  email: string;
  mobile: string | null;
  /** Newest application first. */
  applications: AccountApplication[];
}

export interface LocationEntry {
  /** The applications the row is written for (one per eligible application at LOGIN). */
  candidateIds: string[];
  sessionFamily: string;
  stage: 'LOGIN' | 'EXAM_START';
  permission: 'GRANTED' | 'DENIED' | 'UNAVAILABLE' | 'TIMEOUT' | 'UNSUPPORTED';
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  eventType: string;
  client: ClientInfo;
}

export interface CandidateAuthRepository {
  findByIdentifier(identifier: string): Promise<CandidateAccountRecord | null>;
  findById(id: string): Promise<CandidateAccountRecord | null>;
  /** Sets the mobile on the account and all its applications, once. */
  linkMobile(accountId: string, mobile: string): Promise<'linked' | 'already_linked' | 'mobile_in_use'>;
  hasGrantedLogin(accountId: string, sessionFamily: string): Promise<boolean>;
  recordLocation(entry: LocationEntry): Promise<void>;
  recordActivity(entry: {
    candidateId: string;
    eventType: string;
    ip: string;
    userAgent: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
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
// The code is issued per (account, mobile), so it only ever verifies the number it was sent to.
const linkSubject = (accountId: string, mobile: string) => `${accountId}:${mobile}`;
const sameRoll = (stored: string | null, typed: string) =>
  stored !== null && stored.trim().toLowerCase() === typed.trim().toLowerCase();
const invalidOtp = () => new AppError(400, 'OTP_INVALID', 'Incorrect code.');
const eligibleOf = (a: CandidateAccountRecord) => a.applications.filter((x) => x.eligible);

const EVENT_BY_PERMISSION: Record<LocationEntry['permission'], string> = {
  GRANTED: 'LOCATION_CAPTURED',
  DENIED: 'LOCATION_DENIED',
  UNAVAILABLE: 'LOCATION_UNAVAILABLE',
  UNSUPPORTED: 'LOCATION_UNAVAILABLE',
  TIMEOUT: 'LOCATION_TIMEOUT',
};

export function createCandidateAuthService(deps: CandidateAuthDeps) {
  const toSelf = (a: CandidateAccountRecord, locationCaptured: boolean): CandidateSelf => {
    const eligible = eligibleOf(a);
    return {
      id: a.id,
      fullName: eligible[0]?.fullName ?? '',
      // The candidate's own address, still masked: the browser never needs it in full.
      email: maskEmail(a.email),
      locationCaptured,
      locationExempt: eligible.length > 0 && eligible.every((x) => x.locationExempt),
      examCount: eligible.length,
    };
  };

  /** Account events are written to every eligible application, where HR reads them. */
  const logAll = (account: CandidateAccountRecord, eventType: string, client: ClientInfo, metadata?: Record<string, unknown>) =>
    Promise.all(
      eligibleOf(account).map((app) =>
        deps.repo.recordActivity({ candidateId: app.id, eventType, ip: client.ip, userAgent: client.userAgent, ...(metadata ? { metadata } : {}) }),
      ),
    ).then(() => undefined);

  /** The account for an identifier, only if it has an eligible application. */
  async function findActive(identifier: string): Promise<CandidateAccountRecord | null> {
    const account = await deps.repo.findByIdentifier(identifier);
    return account && eligibleOf(account).length > 0 ? account : null;
  }

  async function requestOtp(input: { identifier: string; client: ClientInfo }): Promise<{ sent: true }> {
    const account = await findActive(input.identifier);
    if (!account) return { sent: true };
    try {
      await deps.otp.issue({
        purpose: 'candidate_login',
        subjectId: account.id,
        recipient: { email: account.email, mobile: account.mobile },
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'OTP_COOLDOWN') throw err;
      const reason = err instanceof AppError ? err.code : 'delivery_error';
      logger.warn('Candidate OTP could not be issued', { reason });
      await deps.audit({
        adminId: null,
        action: 'CANDIDATE_OTP_FAILED',
        entity: AUTH,
        entityId: account.id,
        ip: input.client.ip,
        metadata: { reason },
      });
      await logAll(account, 'OTP_DELIVERY_FAILED', input.client, { reason });
    }
    return { sent: true };
  }

  async function mint(account: CandidateAccountRecord, refreshToken: string): Promise<CandidateSignedIn> {
    const family = await peekRefreshFamily('candidate', refreshToken);
    if (!family) throw unauthorized();
    return {
      candidate: toSelf(account, await deps.repo.hasGrantedLogin(account.id, family)),
      accessToken: signAccess('candidate', { sub: account.id, fam: family }),
      refreshToken,
    };
  }

  async function verifyOtp(input: { identifier: string; code: string; client: ClientInfo }): Promise<CandidateSignedIn> {
    const account = await findActive(input.identifier);
    if (!account) throw invalidOtp();
    await deps.otp.verify({ purpose: 'candidate_login', subjectId: account.id, code: input.code });
    await logAll(account, 'OTP_VERIFIED', input.client);
    return mint(account, await issueRefreshToken('candidate', account.id));
  }

  type LinkInput = { email: string; rollNumber: string; mobile: string; client: ClientInfo };

  // The IP is repeated in metadata because the candidate page shows metadata, not the ip column.
  const logLink = (applicationIds: string[], eventType: string, client: ClientInfo, metadata: Record<string, unknown>) =>
    Promise.all(
      applicationIds.map((id) =>
        deps.repo.recordActivity({ candidateId: id, eventType, ip: client.ip, userAgent: client.userAgent, metadata: { ...metadata, ip: client.ip } }),
      ),
    ).then(() => undefined);

  /** Matches only an account with an eligible application whose roll number agrees; the matching applications are returned too. */
  async function findForLink(email: string, rollNumber: string) {
    const account = await deps.repo.findByIdentifier(email);
    if (!account) return null;
    const matching = eligibleOf(account).filter((a) => sameRoll(a.rollNumber, rollNumber));
    return matching.length > 0 ? { account, matching: matching.map((a) => a.id) } : null;
  }

  async function requestMobileLink(input: LinkInput): Promise<{ sent: true }> {
    const found = await findForLink(input.email, input.rollNumber);
    if (!found) return { sent: true };
    const { account, matching } = found;
    if (account.mobile !== null) {
      // Someone tried to register a phone on an account that already has one: HR should see it.
      await logLink(matching, 'MOBILE_LINK_REFUSED', input.client, { reason: 'already_linked', mobile: maskMobile(input.mobile) });
      return { sent: true };
    }
    const holder = await deps.repo.findByIdentifier(input.mobile);
    if (holder) {
      await logLink(matching, 'MOBILE_LINK_REFUSED', input.client, { reason: 'mobile_in_use', mobile: maskMobile(input.mobile) });
      return { sent: true };
    }
    try {
      await deps.otp.issue({
        purpose: LINK,
        subjectId: linkSubject(account.id, input.mobile),
        recipient: { email: null, mobile: input.mobile },
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'OTP_COOLDOWN') throw err;
      const reason = err instanceof AppError ? err.code : 'delivery_error';
      logger.warn('Mobile registration OTP could not be issued', { reason });
      await deps.audit({ adminId: null, action: 'CANDIDATE_OTP_FAILED', entity: LINK, entityId: account.id, ip: input.client.ip, metadata: { reason } });
      await logLink(matching, 'OTP_DELIVERY_FAILED', input.client, { reason, purpose: LINK });
    }
    return { sent: true };
  }

  async function verifyMobileLink(input: LinkInput & { code: string }): Promise<CandidateSignedIn> {
    const found = await findForLink(input.email, input.rollNumber);
    if (!found || found.account.mobile !== null) throw invalidOtp();
    const { account, matching } = found;
    await deps.otp.verify({ purpose: LINK, subjectId: linkSubject(account.id, input.mobile), code: input.code });

    const outcome = await deps.repo.linkMobile(account.id, input.mobile);
    if (outcome === 'mobile_in_use') {
      throw conflict('This mobile number is already registered to another candidate. Please contact HR.');
    }
    if (outcome === 'already_linked') throw invalidOtp();

    const masked = maskMobile(input.mobile);
    await logLink(matching, 'MOBILE_SELF_REGISTERED', input.client, { mobile: masked });
    await deps.audit({
      adminId: null,
      action: 'CANDIDATE_MOBILE_SELF_REGISTERED',
      entity: LINK,
      entityId: account.id,
      ip: input.client.ip,
      metadata: { mobile: masked },
    });
    return mint({ ...account, mobile: input.mobile }, await issueRefreshToken('candidate', account.id));
  }

  async function refresh(refreshToken: string | undefined): Promise<CandidateSignedIn> {
    if (!refreshToken) throw unauthorized();
    const rotated = await rotateRefreshToken('candidate', refreshToken);
    const account = await deps.repo.findById(rotated.subjectId);
    if (!account || eligibleOf(account).length === 0) {
      await revokeRefreshToken('candidate', rotated.token);
      throw unauthorized();
    }
    return mint(account, rotated.token);
  }

  async function logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) await revokeRefreshToken('candidate', refreshToken);
  }

  /** Used by the auth middleware: an account keeps access while it has an eligible application. */
  async function isActive(accountId: string): Promise<boolean> {
    const account = await deps.repo.findById(accountId);
    return !!account && eligibleOf(account).length > 0;
  }

  async function me(accountId: string, sessionFamily: string): Promise<{ candidate: CandidateSelf }> {
    const account = await deps.repo.findById(accountId);
    if (!account || eligibleOf(account).length === 0) throw unauthorized();
    return { candidate: toSelf(account, await deps.repo.hasGrantedLogin(accountId, sessionFamily)) };
  }

  /**
   * LOGIN: one row per eligible application of the account. EXAM_START: only
   * the application being started (`applicationId`, already ownership-checked).
   */
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
    applicationId?: string,
  ) {
    let candidateIds: string[];
    if (input.stage === 'EXAM_START') {
      if (!applicationId) throw badRequest('An exam start location needs the exam being started.');
      candidateIds = [applicationId];
    } else {
      const account = await deps.repo.findById(auth.id);
      if (!account) throw unauthorized();
      candidateIds = eligibleOf(account).map((a) => a.id);
    }
    const granted = input.permission === 'GRANTED';
    await deps.repo.recordLocation({
      candidateIds,
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

  return { requestOtp, verifyOtp, requestMobileLink, verifyMobileLink, refresh, logout, isActive, me, recordLocation };
}

export type CandidateAuthService = ReturnType<typeof createCandidateAuthService>;
