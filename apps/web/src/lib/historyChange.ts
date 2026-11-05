// src/lib/historyChange.ts
// Why: one line per candidate history row. A row can change the exam status, HR's
// result (shortlist / reject, or cleared by a reopen or reset), or both. Pure so it is
// unit tested.

type Result = 'SHORTLISTED' | 'REJECTED' | null;

const words = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const resultWord = (r: Result) => (r ? words(r) : 'None');

export function historyChangeText(h: { fromStatus: string | null; toStatus: string; fromResult: Result; toResult: Result }): string {
  const parts: string[] = [];
  if (!h.fromStatus) parts.push(words(h.toStatus));
  else if (h.fromStatus !== h.toStatus) parts.push(`${words(h.fromStatus)} to ${words(h.toStatus)}`);
  if (h.fromResult !== h.toResult) parts.push(`Result: ${resultWord(h.fromResult)} to ${resultWord(h.toResult)}`);
  return parts.length > 0 ? parts.join('; ') : `${words(h.fromStatus ?? h.toStatus)} to ${words(h.toStatus)}`;
}
