// modules/adminAuth/adminAuth.service.ts
// Admin sign-in (design §3, §13): email + password, then an emailed OTP.
// - A wrong email, a wrong password and an inactive account all get the same
//   generic UNAUTHORIZED, and an unknown email still pays for a bcrypt compare,
//   so neither the response nor its timing tells an attacker which accounts exist.
// - 5 consecutive wrong passwords lock the account for 15 min; while locked
//   even the right password is refused and no OTP is sent.
// - The password step returns an opaque challengeId (Redis, 5 min) that the
//   OTP step redeems; the OTP itself is the shared otp module.
// Every outcome is audited. Dependencies are injected so the rules are unit
// tested without a database.

import bcrypt from 'bcrypt';
import type { AdminPublic, AdminRole } from '@exam/shared';
import { AppError, unauthorized } from '../../shared/errors.js';
import { maskEmail } from '../../shared/utils/piiMask.js';
import type { AuditRecord } from '../audit/index.js';
import {
  issueRefreshToken,
  peekRefreshFamily,
  revokeAllSessions,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccess,
} from './tokens.js';

const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60_000;
// bcrypt(cost 12) of a random throwaway: compared against when the email is
// unknown so that path costs the same as a real password check.
const DUMMY_HASH = '$2b$12$rYoId7xchRVtlzozU89PIusTmDaJo1W7Qn2fc9bVy3Kbt4b2ZrFYK';

export interface AdminAuthRecord {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  active: boolean;
  passwordHash: string;
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export interface AdminAuthRepository {
  findByEmail(email: string): Promise<AdminAuthRecord | null>;
  findById(id: string): Promise<AdminAuthRecord | null>;
  /** Atomically adds one failure and returns the new count. */
  registerFailure(id: string): Promise<number>;
  /** Sets lockedUntil and restarts the failure count for after the lock. */
  lock(id: string, until: Date): Promise<void>;
  clearFailures(id: string): Promise<void>;
  markLoggedIn(id: string, at: Date): Promise<void>;
}

export interface ChallengeStore {
  create(adminId: string): Promise<string>;
  peek(challengeId: string): Promise<string | null>;
  drop(challengeId: string): Promise<void>;
}

export interface AdminAuthDeps {
  repo: AdminAuthRepository;
  audit: (entry: AuditRecord) => Promise<void>;
  otp: {
    issue: (p: { purpose: 'admin_login'; subjectId: string; recipient: { email: string; mobile: null } }) => Promise<unknown>;
    verify: (p: { purpose: 'admin_login'; subjectId: string; code: string }) => Promise<void>;
  };
  challenges: ChallengeStore;
  now?: () => Date;
}

export interface SignedIn {
  admin: AdminPublic;
  accessToken: string;
  refreshToken: string;
}

const INVALID_MESSAGE = 'Invalid email or password.';
const invalidCredentials = () => unauthorized(INVALID_MESSAGE);
const accountLocked = () =>
  new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in 15 minutes.');

const toPublic = (a: AdminAuthRecord): AdminPublic => ({ id: a.id, name: a.name, email: a.email, role: a.role });

export function createAdminAuthService(deps: AdminAuthDeps) {
  const now = deps.now ?? (() => new Date());
  const AUTH = 'admin_auth';

  async function login(input: { email: string; password: string; ip: string | null }) {
    const { email, password, ip } = input;
    const admin = await deps.repo.findByEmail(email);

    if (!admin) {
      await bcrypt.compare(password, DUMMY_HASH);
      await deps.audit({ adminId: null, action: 'ADMIN_LOGIN_FAILED', entity: AUTH, ip, metadata: { reason: 'unknown_email', email: maskEmail(email) } });
      throw invalidCredentials();
    }
    const fail = (reason: string) =>
      deps.audit({ adminId: admin.id, action: 'ADMIN_LOGIN_FAILED', entity: AUTH, entityId: admin.id, ip, metadata: { reason } });

    if (admin.lockedUntil && admin.lockedUntil > now()) {
      await fail('locked');
      throw accountLocked();
    }

    const passwordOk = await bcrypt.compare(password, admin.passwordHash);
    if (!passwordOk) {
      const count = await deps.repo.registerFailure(admin.id);
      if (count >= MAX_FAILED_LOGINS) {
        const until = new Date(now().getTime() + LOCK_MS);
        await deps.repo.lock(admin.id, until);
        await deps.audit({ adminId: admin.id, action: 'ADMIN_LOCKED', entity: AUTH, entityId: admin.id, ip, metadata: { until: until.toISOString() } });
        throw accountLocked();
      }
      await fail('bad_password');
      throw invalidCredentials();
    }
    if (!admin.active) {
      await fail('inactive');
      throw invalidCredentials();
    }

    await deps.repo.clearFailures(admin.id);
    // OTP_COOLDOWN (429) propagates: a repeated login inside 60 s is the resend.
    await deps.otp.issue({ purpose: 'admin_login', subjectId: admin.id, recipient: { email: admin.email, mobile: null } });
    const challengeId = await deps.challenges.create(admin.id);
    return { otpRequired: true as const, challengeId };
  }

  // The access token names its login family so logout can kill it at once.
  async function signIn(admin: AdminAuthRecord): Promise<SignedIn> {
    const refreshToken = await issueRefreshToken('admin', admin.id);
    const fam = await peekRefreshFamily('admin', refreshToken);
    if (!fam) throw unauthorized();
    return {
      admin: toPublic(admin),
      accessToken: signAccess('admin', { sub: admin.id, role: admin.role, fam }),
      refreshToken,
    };
  }

  async function verifyOtp(input: { challengeId: string; code: string; ip: string | null }): Promise<SignedIn> {
    const adminId = await deps.challenges.peek(input.challengeId);
    if (!adminId) throw new AppError(400, 'OTP_EXPIRED', 'This code has expired. Please sign in again.');
    try {
      await deps.otp.verify({ purpose: 'admin_login', subjectId: adminId, code: input.code });
    } catch (err) {
      if (err instanceof AppError) {
        await deps.audit({ adminId, action: 'ADMIN_OTP_FAILED', entity: AUTH, entityId: adminId, ip: input.ip, metadata: { reason: err.code } });
        if (err.code !== 'OTP_INVALID') await deps.challenges.drop(input.challengeId);
      }
      throw err;
    }
    await deps.challenges.drop(input.challengeId);
    const admin = await deps.repo.findById(adminId);
    if (!admin || !admin.active) throw unauthorized();
    await deps.repo.markLoggedIn(admin.id, now());
    await deps.audit({ adminId: admin.id, action: 'ADMIN_LOGIN_SUCCESS', entity: AUTH, entityId: admin.id, ip: input.ip });
    return signIn(admin);
  }

  // A retired refresh token presented again means it leaked: the family is
  // revoked by rotateRefreshToken and the event is audited here.
  async function refresh(refreshToken: string | undefined, ip: string | null = null): Promise<SignedIn> {
    if (!refreshToken) throw unauthorized();
    const rotated = await rotateRefreshToken('admin', refreshToken, {
      onReuse: (adminId) =>
        deps.audit({ adminId, action: 'ADMIN_REFRESH_REUSE', entity: AUTH, entityId: adminId, ip }),
    });
    const admin = await deps.repo.findById(rotated.subjectId);
    if (!admin || !admin.active) {
      await revokeRefreshToken('admin', rotated.token);
      throw unauthorized();
    }
    return {
      admin: toPublic(admin),
      accessToken: signAccess('admin', { sub: admin.id, role: admin.role, fam: rotated.family }),
      refreshToken: rotated.token,
    };
  }

  async function logout(refreshToken: string | undefined, ip: string | null): Promise<void> {
    if (!refreshToken) return;
    const adminId = await revokeRefreshToken('admin', refreshToken);
    if (adminId) await deps.audit({ adminId, action: 'ADMIN_LOGOUT', entity: AUTH, entityId: adminId, ip });
  }

  /** Signs the admin out everywhere: every refresh family and access token issued so far. */
  async function logoutAll(adminId: string, ip: string | null): Promise<void> {
    await revokeAllSessions('admin', adminId);
    await deps.audit({ adminId, action: 'ADMIN_LOGOUT_ALL', entity: AUTH, entityId: adminId, ip });
  }

  async function me(adminId: string): Promise<{ admin: AdminPublic }> {
    const admin = await deps.repo.findById(adminId);
    if (!admin || !admin.active) throw unauthorized();
    return { admin: toPublic(admin) };
  }

  return { login, verifyOtp, refresh, logout, logoutAll, me };
}

export type AdminAuthService = ReturnType<typeof createAdminAuthService>;
