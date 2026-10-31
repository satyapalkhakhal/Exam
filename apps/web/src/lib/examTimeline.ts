// src/lib/examTimeline.ts
// Why: turns the raw exam events on the marking screen into readable timeline rows: a
// label, a severity, the time into the exam, and, for a return (tab visible, focus,
// back online), how long the candidate was away. Pure, so it is unit tested.

import type { TimelineEvent } from '@/api/admin/evaluation';

export type Severity = 'flag' | 'warn' | 'info';

const META: Record<string, { label: string; severity: Severity }> = {
  EXAM_STARTED: { label: 'Exam started', severity: 'info' },
  SESSION_TAKEOVER: { label: 'Exam opened in another window or device', severity: 'flag' },
  QUESTION_VIEWED: { label: 'Opened question', severity: 'info' },
  PASTE_ATTEMPT: { label: 'Paste attempt blocked', severity: 'flag' },
  COPY_ATTEMPT: { label: 'Copy attempt blocked', severity: 'flag' },
  CUT_ATTEMPT: { label: 'Cut attempt blocked', severity: 'flag' },
  DROP_ATTEMPT: { label: 'Drag-and-drop blocked', severity: 'flag' },
  CONTEXT_MENU: { label: 'Right-click blocked', severity: 'flag' },
  SUSPICIOUS_BULK_INSERT: { label: 'Suspicious bulk insert', severity: 'flag' },
  TAB_HIDDEN: { label: 'Left the exam tab', severity: 'warn' },
  TAB_VISIBLE: { label: 'Returned to the exam tab', severity: 'info' },
  WINDOW_BLUR: { label: 'Exam window lost focus', severity: 'warn' },
  WINDOW_FOCUS: { label: 'Exam window focused again', severity: 'info' },
  PAGE_UNLOAD: { label: 'Page closed or reloaded', severity: 'warn' },
  NETWORK_OFFLINE: { label: 'Went offline', severity: 'warn' },
  NETWORK_ONLINE: { label: 'Back online', severity: 'info' },
  IP_CHANGED: { label: 'Network (IP address) changed', severity: 'flag' },
  EXAM_SUBMITTED: { label: 'Submitted', severity: 'info' },
  EXAM_AUTO_SUBMITTED: { label: 'Auto-submitted at time-up', severity: 'info' },
};

// A return event closes the most recent matching "away" event.
const RETURNS: Record<string, string> = { TAB_VISIBLE: 'TAB_HIDDEN', WINDOW_FOCUS: 'WINDOW_BLUR', NETWORK_ONLINE: 'NETWORK_OFFLINE' };

export interface TimelineRow {
  key: string;
  at: Date;
  /** Milliseconds since the exam started (never negative). */
  sinceStartMs: number;
  type: string;
  label: string;
  severity: Severity;
  questionOrder: number | null;
  /** For a return event: how long the matching away period lasted. */
  awayMs: number | null;
  detail: string | null;
}

export function buildTimeline(events: TimelineEvent[], startedAt: string): TimelineRow[] {
  const start = new Date(startedAt).getTime();
  const openAway: Record<string, number> = {};
  return events.map((e, i) => {
    const at = new Date(e.at);
    const t = at.getTime();
    const meta = META[e.type] ?? { label: e.type, severity: 'info' as const };
    let awayMs: number | null = null;
    const opener = RETURNS[e.type];
    if (opener !== undefined && openAway[opener] !== undefined) {
      awayMs = Math.max(0, t - openAway[opener]!);
      delete openAway[opener];
    }
    if (Object.values(RETURNS).includes(e.type)) openAway[e.type] = t;
    return {
      key: `${i}-${e.at}-${e.type}`,
      at,
      sinceStartMs: Math.max(0, t - start),
      type: e.type,
      label: meta.label,
      severity: meta.severity,
      questionOrder: e.questionOrder,
      awayMs,
      detail: e.bulk ? `answer grew ${e.bulk.grown} chars, ${e.bulk.typed} typed` : null,
    };
  });
}

/** "+05:07" or "+1:05:07" into the exam. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `+${h}:${mm}:${ss}` : `+${mm}:${ss}`;
}

/** "45s", "3m 20s", "1h 02m". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Counts per flagged/warning label, for the summary chips above the timeline. */
export function summarize(rows: TimelineRow[]): { label: string; severity: Severity; count: number }[] {
  const byLabel = new Map<string, { label: string; severity: Severity; count: number }>();
  for (const r of rows) {
    if (r.severity === 'info') continue;
    const cur = byLabel.get(r.type) ?? { label: r.label, severity: r.severity, count: 0 };
    cur.count += 1;
    byLabel.set(r.type, cur);
  }
  return [...byLabel.values()].sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === 'flag' ? -1 : 1));
}
