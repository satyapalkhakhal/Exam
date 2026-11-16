// src/components/admin/ResultBadge.tsx
// Why: HR's shortlist / reject outcome, shown the same way on every admin page. With no
// decision yet, "Evaluated" once the marks are confirmed (it is not a status: the status
// keeps saying how the exam ended), else nothing.

import type { CandidateResult } from '@exam/shared';
import { Badge } from '@/components/ui/badge';

export const RESULT_TEXT: Record<CandidateResult, string> = { SHORTLISTED: 'Shortlisted', REJECTED: 'Rejected' };

export function ResultBadge({ result, evaluated = false }: { result: CandidateResult | null; evaluated?: boolean }) {
  if (!result) return evaluated ? <Badge className="border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400">Evaluated</Badge> : null;
  return result === 'SHORTLISTED' ? (
    <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">Shortlisted</Badge>
  ) : (
    <Badge variant="destructive">Rejected</Badge>
  );
}
