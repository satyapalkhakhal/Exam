// modules/audit/audit.service.ts
// The admin audit trail (design §13): every admin write and every auth event is
// recorded here. Append-only by construction: the repository can only create
// and list. adminId is null for events with no signed-in admin (an unknown
// email at login, the break-glass CLI). Callers must never put secrets, OTPs,
// passwords or unmasked PII into metadata.

import type { Paginated } from '@exam/shared';

export interface AuditRecord {
  adminId: string | null;
  action: string;
  entity: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditRow {
  id: string;
  adminId: string | null;
  adminName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: Date;
}

export interface AuditFilter {
  entity?: string;
  adminId?: string;
  from?: Date;
  toExclusive?: Date;
}

export interface AuditRepository {
  create(entry: AuditRecord): Promise<void>;
  list(filter: AuditFilter, skip: number, take: number): Promise<{ items: AuditRow[]; total: number }>;
}

export const AUDIT_PAGE_SIZE = 50;

// Date filters arrive as calendar days and are read in India time, the only
// timezone this platform's admins work in; `to` is inclusive of its whole day.
const IST = '+05:30';
const startOfDay = (day: string): Date => new Date(`${day}T00:00:00${IST}`);
const nextDay = (day: string): Date => new Date(startOfDay(day).getTime() + 86_400_000);

export function createAuditService(repo: AuditRepository) {
  async function record(entry: AuditRecord): Promise<void> {
    await repo.create(entry);
  }

  async function list(q: {
    page: number;
    entity?: string;
    adminId?: string;
    from?: string;
    to?: string;
  }): Promise<Paginated<AuditRow>> {
    const filter: AuditFilter = {
      entity: q.entity,
      adminId: q.adminId,
      from: q.from ? startOfDay(q.from) : undefined,
      toExclusive: q.to ? nextDay(q.to) : undefined,
    };
    const { items, total } = await repo.list(filter, (q.page - 1) * AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZE);
    return { items, total, page: q.page, pageSize: AUDIT_PAGE_SIZE };
  }

  return { record, list };
}

export type AuditService = ReturnType<typeof createAuditService>;
