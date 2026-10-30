// modules/integrations/integrations.repository.ts
// The one read the Integrations screen needs outside system_configs: how many
// candidates have no mobile on file (they can only receive email OTPs).

import { prisma } from '../../infrastructure/db/prisma.js';

export const integrationsRepository = {
  countCandidatesWithoutMobile: (): Promise<number> => prisma.candidate.count({ where: { mobile: null } }),
};
