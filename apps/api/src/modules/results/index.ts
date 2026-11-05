// modules/results/index.ts
// Barrel: decisions, leaderboard, dashboard and exports on the Prisma
// repository, with review flags from the exam engine and decision emails
// through the emails module.

import { emails } from '../emails/index.js';
import { exam } from '../exam/index.js';
import { getEmailConfig, isChannelReady } from '../messaging/index.js';
import { resultsRepository } from './results.repository.js';
import { createResultsService } from './results.service.js';

export { createResultsRouter } from './results.routes.js';
export { createResultsService } from './results.service.js';
export type { ResultsService } from './results.service.js';

export const results = createResultsService({
  repo: resultsRepository,
  getFlagsBatch: exam.getFlagsBatch,
  emailReady: async () => isChannelReady(await getEmailConfig()),
  sendEmails: (input, adminId) => emails.send(input, adminId),
});
