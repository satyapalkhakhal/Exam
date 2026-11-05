// src/components/admin/ResultBadge.tsx
// Why: HR's shortlist / reject outcome, shown the same way on every admin page; nothing
// when there is no decision yet.

import type { CandidateResult } from '@exam/shared';
import { Badge } from '@/components/ui/badge';

export const RESULT_TEXT: Record<CandidateResult, string> = { SHORTLISTED: 'Shortlisted', REJECTED: 'Rejected' };

export function ResultBadge({ result }: { result: CandidateResult | null }) {
  if (!result) return null;
  return result === 'SHORTLISTED' ? (
    <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">Shortlisted</Badge>
  ) : (
    <Badge variant="destructive">Rejected</Badge>
  );
}
