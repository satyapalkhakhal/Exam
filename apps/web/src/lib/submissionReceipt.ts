// src/lib/submissionReceipt.ts
// Why: the rows of the candidate's submission receipt (who, what, when, how many answered, and
// whether HR selected them for the next round). Pure so it is unit tested; never marks or answers.

import type { CandidateSelection, ExamSummaryDto } from '@exam/shared';
import { formatIst } from '@/lib/istTime';

export interface ReceiptCandidate {
  fullName: string;
  email: string;
  candidateCode: string;
  jobRole: { name: string };
  selectedForNextRound: CandidateSelection;
}

const SELECTION_LABEL: Record<CandidateSelection, string> = { YES: 'Yes', NO: 'No', AWAITED: 'Result awaited' };

/** "Yes" once shortlisted, "No" once rejected, "Result awaited" until HR decides. */
export function selectionLabel(s: CandidateSelection): string {
  return SELECTION_LABEL[s];
}

/** "52 min 30 s", "1 h 5 min", "40 s"; "-" when either time is missing. */
export function timeTaken(startedAt: string | null, submittedAt: string | null): string {
  if (!startedAt || !submittedAt) return '-';
  const s = Math.max(0, Math.round((Date.parse(submittedAt) - Date.parse(startedAt)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return sec > 0 ? `${m} min ${sec} s` : `${m} min`;
  return `${sec} s`;
}

export function receiptRows(c: ReceiptCandidate, s: ExamSummaryDto): { label: string; value: string }[] {
  const auto = s.submitType === 'AUTO' || s.status === 'AUTO_SUBMITTED';
  return [
    { label: 'Name', value: c.fullName },
    { label: 'Email', value: c.email },
    { label: 'Exam code', value: c.candidateCode },
    { label: 'Job profile', value: c.jobRole.name },
    { label: 'Started at', value: formatIst(s.startedAt) },
    { label: 'Submitted at', value: formatIst(s.submittedAt) },
    { label: 'Time taken', value: timeTaken(s.startedAt, s.submittedAt) },
    { label: 'Submission', value: auto ? 'Auto-submitted when time was up' : 'Submitted by you' },
    { label: 'Questions', value: `${s.answeredCount} of ${s.questionCount} answered` },
    { label: 'Selected for next round', value: selectionLabel(c.selectedForNextRound) },
  ];
}
