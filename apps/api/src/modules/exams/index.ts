// modules/exams/index.ts
// Barrel: exams and their rounds on the Prisma repository.

import { examsRepository } from './exams.repository.js';
import { createExamsService } from './exams.service.js';

export { createExamsRouter } from './exams.routes.js';
export { createExamsService } from './exams.service.js';
export type { ExamsService, ExamsRepository, ExamRow, RoundRow } from './exams.service.js';
export { examsRepository };

export const exams = createExamsService(examsRepository);
