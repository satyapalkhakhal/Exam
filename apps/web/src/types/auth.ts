// src/types/auth.ts
// Shapes of the /me and verify-otp payloads. CandidateSelf is the shared account-level
// shape (docs/multi-exam.md); per-role data lives in CandidateExamDto.

import type { AdminRole, CandidateSelf } from '@exam/shared';

export interface AdminSelf {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
}

export type { CandidateSelf };
