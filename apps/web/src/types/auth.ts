// src/types/auth.ts
// Shapes of the /me and verify-otp payloads. Defined here because
// @exam/shared does not export them (the API contracts are in plan Tasks 5-6).

import type { AdminRole } from '@exam/shared';

export interface AdminSelf {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
}

export interface CandidateSelf {
  id: string;
  candidateCode: string;
  fullName: string;
  email: string;
  jobRole: { id: string; name: string };
  status: string;
  locationCaptured: boolean;
  locationExempt: boolean;
}
