// modules/candidateAuth/index.ts
// Barrel: the candidate sign-in service wired to Prisma, Redis, the OTP module
// and the audit log.

import { audit } from '../audit/index.js';
import { issueOtp, verifyOtp } from '../otp/index.js';
import { candidateAuthRepository } from './candidateAuth.repository.js';
import { createCandidateAuthService } from './candidateAuth.service.js';

export { createCandidateAuthRouter } from './candidateAuth.routes.js';
export { createCandidateAuthService } from './candidateAuth.service.js';
export type { CandidateAuthService, CandidateAuthRepository, CandidateAuthRecord } from './candidateAuth.service.js';

export const candidateAuthService = createCandidateAuthService({
  repo: candidateAuthRepository,
  audit: (entry) => audit.record(entry),
  otp: { issue: issueOtp, verify: verifyOtp },
});
