// src/lib/emailTemplates.ts
// Why: pure helpers behind the email template editor and the Send email dialog, kept out
// of the components so they are unit-tested: cursor insertion for placeholder chips, an
// inline warning for unknown {tokens} (the API rejects them on save), the IST form ->
// NextRound payload mapping, and plain-words skip reasons.

import type { EmailSkipReason, NextRoundInput } from '@exam/shared';
import { istInputToIso } from './istTime.js';

/** "firstName" or "{firstName}" -> "{firstName}". */
export function placeholderText(token: string): string {
  return token.startsWith('{') ? token : `{${token}}`;
}

/** Insert `token` at the selection (replacing it) and return the new text and caret position. */
export function insertAtCursor(text: string, start: number, end: number, token: string): { text: string; cursor: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return { text: text.slice(0, s) + token + text.slice(e), cursor: s + token.length };
}

/** Distinct {tokens} in the text that are not in `allowed` (names, with or without braces). */
export function unknownPlaceholders(text: string, allowed: readonly string[]): string[] {
  const ok = new Set(allowed.map((a) => a.replace(/^\{|\}$/g, '')));
  const found = new Set<string>();
  for (const m of text.matchAll(/\{([^{}\s]*)\}/g)) {
    if (!ok.has(m[1]!)) found.add(m[0]);
  }
  return [...found];
}

export interface NextRoundForm {
  name: string;
  mode: string;
  /** datetime-local value in IST. */
  scheduledAt: string;
  confirmBy: string;
  venue: string;
  link: string;
  linkLabel: string;
  instructions: string;
}

export const EMPTY_NEXT_ROUND: NextRoundForm = {
  name: '', mode: '', scheduledAt: '', confirmBy: '', venue: '', link: '', linkLabel: '', instructions: '',
};

/** Form -> API payload: blanks dropped, IST datetimes to ISO with offset. Undefined when nothing is filled. */
export function nextRoundPayload(f: NextRoundForm): NextRoundInput | undefined {
  const out: NextRoundInput = {};
  const text = (k: 'name' | 'mode' | 'venue' | 'link' | 'linkLabel' | 'instructions') => {
    const v = f[k].trim();
    if (v) out[k] = v;
  };
  (['name', 'mode', 'venue', 'link', 'linkLabel', 'instructions'] as const).forEach(text);
  const at = istInputToIso(f.scheduledAt);
  if (at) out.scheduledAt = at;
  const by = istInputToIso(f.confirmBy);
  if (by) out.confirmBy = by;
  return Object.keys(out).length ? out : undefined;
}

/** Client-side check mirroring the API: the link must be https. Returns an error message or null. */
export function nextRoundLinkError(link: string): string | null {
  const v = link.trim();
  if (!v) return null;
  try {
    new URL(v);
  } catch {
    return 'Enter a valid link';
  }
  return v.startsWith('https://') ? null : 'The link must start with https://';
}

export const SKIP_REASON_LABEL: Record<EmailSkipReason, string> = {
  NOT_FOUND: 'No longer exists',
  INELIGIBLE: 'Marked not eligible',
  NOT_SUBMITTED: 'Has not submitted the exam',
  NOT_SHORTLISTED: 'Is not shortlisted',
  ALREADY_SENT: 'Already received this email',
};

export function skipReasonLabel(reason: EmailSkipReason): string {
  return SKIP_REASON_LABEL[reason] ?? reason;
}
