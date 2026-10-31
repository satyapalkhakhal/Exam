// src/components/admin/ExamTimeline.tsx
// Why: shows the evaluator what happened during the exam, in order, with the clock time and
// the time into the exam: integrity flags (paste, bulk insert, IP change, takeover), time
// away (tab hidden, focus lost, offline) and the exam's start and submit. Question views are
// hidden by default because they are frequent and rarely matter. No IPs or devices: the API
// never sends them to this screen.

import { useMemo, useState } from 'react';
import type { TimelineEvent } from '@/api/admin/evaluation';
import { Badge } from '@/components/ui/badge';
import { buildTimeline, formatDuration, formatElapsed, summarize, type Severity } from '@/lib/examTimeline';
import { cn } from '@/lib/utils';

const DOT: Record<Severity, string> = {
  flag: 'bg-destructive',
  warn: 'bg-amber-500',
  info: 'bg-muted-foreground/40',
};
const TEXT: Record<Severity, string> = {
  flag: 'text-destructive font-medium',
  warn: 'text-amber-700 dark:text-amber-400',
  info: 'text-foreground',
};

export function ExamTimeline({ events, startedAt }: { events: TimelineEvent[]; startedAt: string }) {
  const [showViews, setShowViews] = useState(false);
  const [flagsOnly, setFlagsOnly] = useState(false);
  const rows = useMemo(() => buildTimeline(events, startedAt), [events, startedAt]);
  const summary = useMemo(() => summarize(rows), [rows]);
  const visible = rows.filter((r) => (showViews || r.type !== 'QUESTION_VIEWED') && (!flagsOnly || r.severity !== 'info'));

  return (
    <details open className="rounded-lg border border-border bg-card p-4">
      <summary className="cursor-pointer text-sm font-semibold text-foreground">
        Exam timeline <span className="font-normal text-muted-foreground">({rows.length} events)</span>
      </summary>

      <div className="mt-3 space-y-3">
        <div className="flex flex-wrap gap-2 text-xs" aria-label="Event summary">
          {summary.length === 0 && <span className="text-muted-foreground">No integrity flags or time away recorded.</span>}
          {summary.map((s) => (
            <Badge key={s.label} variant={s.severity === 'flag' ? 'destructive' : 'outline'}>
              {s.label}: {s.count}
            </Badge>
          ))}
        </div>

        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={flagsOnly} onChange={(e) => setFlagsOnly(e.target.checked)} />
            Flags and time away only
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={showViews} onChange={(e) => setShowViews(e.target.checked)} />
            Show question navigation
          </label>
        </div>

        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to show with these filters.</p>
        ) : (
          <ol className="relative max-h-96 overflow-y-auto border-l border-border pl-5" aria-label="Exam events in order">
            {visible.map((r) => (
              <li key={r.key} className="relative pb-3 last:pb-0">
                <span className={cn('absolute -left-[1.6rem] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-card', DOT[r.severity])} aria-hidden />
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                  <time dateTime={r.at.toISOString()} className="w-20 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {r.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </time>
                  <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{formatElapsed(r.sinceStartMs)}</span>
                  <span className={TEXT[r.severity]}>{r.label}</span>
                  {r.questionOrder !== null && <Badge variant="outline">Q{r.questionOrder}</Badge>}
                  {r.awayMs !== null && <span className="text-xs text-muted-foreground">away {formatDuration(r.awayMs)}</span>}
                  {r.detail && <span className="text-xs text-muted-foreground">{r.detail}</span>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}
