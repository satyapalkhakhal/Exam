// modules/systemConfig/systemConfig.repository.ts
// The only code that touches the system_configs table.

import { prisma } from '../../infrastructure/db/prisma.js';
import type { SystemConfigRepository } from './systemConfig.service.js';

export const systemConfigRepository: SystemConfigRepository = {
  async findByKey(key) {
    const row = await prisma.systemConfig.findUnique({ where: { key } });
    return row ? { key: row.key, value: row.value } : null;
  },
  async upsert(key, value, adminId) {
    const json = value as object;
    await prisma.systemConfig.upsert({
      where: { key },
      update: { value: json, isSecret: true, updatedById: adminId },
      create: { key, value: json, isSecret: true, updatedById: adminId },
    });
  },
};
