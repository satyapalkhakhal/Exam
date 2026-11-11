// src/api/admin/dashboard.ts
// Why: GET /api/admin/dashboard: one count block per drive for a Super Admin; per
// round (drives summed, no college or batch) for an Evaluator (spec 2026-11-10).

import { useQuery } from '@tanstack/react-query';
import type { DashboardDriveDto } from '@exam/shared';
import { apiFetch } from '@/lib/api';

export type DriveCounts = Pick<
  DashboardDriveDto,
  'refApplicantCount' | 'imported' | 'notStarted' | 'inProgress' | 'submitted' | 'autoSubmitted' | 'evaluated' | 'shortlisted' | 'rejected' | 'pendingEvaluation'
>;
export type DriveDashboard = DashboardDriveDto;

export function useDashboard() {
  return useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: async () => (await apiFetch<{ drives: DriveDashboard[] }>('admin', '/dashboard')).drives,
  });
}
