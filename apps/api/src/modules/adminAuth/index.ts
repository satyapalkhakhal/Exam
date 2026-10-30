// modules/adminAuth/index.ts
// Barrel: the admin sign-in service wired to Prisma, Redis, the OTP module and
// the audit log, plus the token helpers the candidate auth module reuses.

import { audit } from '../audit/index.js';
import { issueOtp, verifyOtp } from '../otp/index.js';
import { adminAuthRepository } from './adminAuth.repository.js';
import { createAdminAuthService } from './adminAuth.service.js';
import { redisChallengeStore } from './challenges.js';

export { createAdminAuthRouter } from './adminAuth.routes.js';
export { createAdminAuthService } from './adminAuth.service.js';
export type { AdminAuthService, AdminAuthRepository, AdminAuthRecord } from './adminAuth.service.js';
export {
  signAccess,
  verifyAccess,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllSessions,
  getSessionsValidAfter,
  assertAccessCurrent,
  assertSessionLive,
  isRefreshFamilyLive,
  peekRefreshFamily,
  setAuthCookies,
  clearAuthCookies,
  COOKIES,
} from './tokens.js';
export type { TokenKind, AccessPayload } from './tokens.js';

export const adminAuthService = createAdminAuthService({
  repo: adminAuthRepository,
  audit: audit.record,
  otp: { issue: issueOtp, verify: verifyOtp },
  challenges: redisChallengeStore,
});
