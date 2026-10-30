// modules/audit/audit.repository.ts
// The only code that touches admin_audit_logs. Deliberately exposes create and
// list only: there is no update or delete path for the audit trail.

import { prisma } from '../../infrastructure/db/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuditRecord, AuditRepository } from './audit.service.js';

/**
 * Writes one audit row on the given client. Other modules pass their
 * transaction client so a change and its audit row commit or roll back together.
 */
export async function writeAudit(db: Prisma.TransactionClient, entry: AuditRecord): Promise<void> {
  await db.adminAuditLog.create({
    data: {
      adminId: entry.adminId,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
      ip: entry.ip ?? null,
    },
  });
}

export const auditRepository: AuditRepository = {
  async create(entry) {
    await writeAudit(prisma, entry);
  },

  async list(filter, skip, take) {
    const where: Prisma.AdminAuditLogWhereInput = {
      ...(filter.entity ? { entity: filter.entity } : {}),
      ...(filter.adminId ? { adminId: filter.adminId } : {}),
      ...(filter.from || filter.toExclusive
        ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.toExclusive ? { lt: filter.toExclusive } : {}) } }
        : {}),
    };
    const [rows, total] = await prisma.$transaction([
      prisma.adminAuditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
        include: { admin: { select: { name: true } } },
      }),
      prisma.adminAuditLog.count({ where }),
    ]);
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        adminId: r.adminId,
        adminName: r.admin?.name ?? null,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        metadata: r.metadata,
        ip: r.ip,
        createdAt: r.createdAt,
      })),
    };
  },
};
