// modules/systemConfig/index.ts
// Barrel: the process-wide config service on the Prisma repository.

import { createSystemConfigService } from './systemConfig.service.js';
import { systemConfigRepository } from './systemConfig.repository.js';

export { SECRET_FIELDS, createSystemConfigService } from './systemConfig.service.js';
export { systemConfigRepository };
export type { SystemConfigService, SystemConfigRepository } from './systemConfig.service.js';

export const systemConfig = createSystemConfigService(systemConfigRepository);
export const getConfig = systemConfig.getConfig;
export const setConfig = systemConfig.setConfig;
