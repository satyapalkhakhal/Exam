// src/lib/examSections.ts
// Why: "My exams" groups a candidate's applications into sections (docs/multi-exam.md). Pure so the
// grouping, and the server-clock availability it relies on, are unit tested; the page only renders.

import { examAvailability, type CandidateExamDto, type ExamAvailability } from '@exam/shared';

export interface ExamSections {
  inProgress: CandidateExamDto[];
  available: CandidateExamDto[];
  upcoming: CandidateExamDto[];
  closed: CandidateExamDto[];
  completed: CandidateExamDto[];
}

/** Availability of an exam not yet started, judged at `nowMs` (the server clock, not the device's). */
export function availabilityOf(exam: CandidateExamDto, nowMs: number): ExamAvailability {
  return examAvailability(exam, new Date(nowMs));
}

export function groupExams(exams: CandidateExamDto[], nowMs: number): ExamSections {
  const out: ExamSections = { inProgress: [], available: [], upcoming: [], closed: [], completed: [] };
  for (const e of exams) {
    if (e.progress === 'IN_PROGRESS') out.inProgress.push(e);
    else if (e.progress === 'SUBMITTED') out.completed.push(e);
    else {
      const a = availabilityOf(e, nowMs);
      if (a === 'OPEN') out.available.push(e);
      else if (a === 'BEFORE_WINDOW') out.upcoming.push(e);
      else out.closed.push(e);
    }
  }
  return out;
}

export const examPaths = {
  detail: (applicationId: string) => `/exams/${applicationId}`,
  take: (applicationId: string) => `/exams/${applicationId}/take`,
  submitted: (applicationId: string) => `/exams/${applicationId}/submitted`,
};
