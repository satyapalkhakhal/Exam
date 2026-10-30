// src/api/admin/audit.ts
// Why: GET /api/admin/audit?entity&adminId&from&to&page (plan Task 5, Super Admin).

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { Paged } from './users';

export interface AuditRow {
  id: string;
  adminId: string | null;
  adminName?: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
}

export interface AuditFilters {
  entity: string;
  adminId: string;
  from: string;
  to: string;
}

export function useAuditLog(filters: AuditFilters, page: number) {
  const qs = new URLSearchParams({ page: String(page) });
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  return useQuery({
    queryKey: ['admin', 'audit', filters, page],
    queryFn: () => apiFetch<Paged<AuditRow>>('admin', `/audit?${qs.toString()}`),
    placeholderData: keepPreviousData,
  });
}
