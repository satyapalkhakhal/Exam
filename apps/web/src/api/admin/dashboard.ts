// src/api/admin/dashboard.ts
// Why: GET /api/admin/dashboard (plan Task 11), one count block per job role.

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface RoleCounts {
  refApplicantCount: number;
  imported: number;
  notStarted: number;
  inProgress: number;
  submitted: number;
  autoSubmitted: number;
  evaluated: number;
  shortlisted: number;
  rejected: number;
  pendingEvaluation: number;
}

// Evaluators receive the same keys; the API pins this shape.
export interface RoleDashboard extends RoleCounts {
  jobRoleId: string;
  jobRoleName: string;
}

export function useDashboard() {
  return useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: async () => (await apiFetch<{ roles: RoleDashboard[] }>('admin', '/dashboard')).roles,
  });
}
