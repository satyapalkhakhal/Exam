// src/components/exam/SaveStatus.tsx
// Why: the candidate must always be able to see whether their text is on the server
// (design 7.4/7.5). The visible label ticks ("Saved 3s ago"); only status *changes* are
// announced to screen readers, so the live region isn't chattering every second.

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudOff, Loader2 } from 'lucide-react';
import type { SaveStatus as Status } from '@/lib/autosave';
import { cn } from '@/lib/utils';

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

const ANNOUNCE: Record<Status, string> = {
  saved: 'All answers saved',
  saving: 'Saving',
  offline: 'Offline, will retry',
  error: 'Not saved, retrying',
  superseded: 'This exam is open in another window',
  locked: 'The exam is closed',
};

export function SaveStatus({ status }: { status: Status }) {
  const [savedAt, setSavedAt] = useState(() => Date.now());
  const [, setTick] = useState(0);

  useEffect(() => {
    if (status === 'saved') setSavedAt(Date.now());
  }, [status]);

  useEffect(() => {
    if (status !== 'saved') return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  let icon = <CheckCircle2 className="h-4 w-4" aria-hidden="true" />;
  let label = `Saved ${ago(Date.now() - savedAt)}`;
  let tone = 'text-emerald-700';
  if (status === 'saving') {
    icon = <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />;
    label = 'Saving…';
    tone = 'text-muted-foreground';
  } else if (status === 'offline') {
    icon = <CloudOff className="h-4 w-4" aria-hidden="true" />;
    label = 'Offline — will retry';
    tone = 'text-amber-700';
  } else if (status === 'error' || status === 'superseded' || status === 'locked') {
    icon = <AlertTriangle className="h-4 w-4" aria-hidden="true" />;
    label = status === 'error' ? 'Not saved — retrying' : status === 'locked' ? 'Exam closed' : 'Open in another window';
    tone = 'text-destructive';
  }

  return (
    <div className={cn('flex items-center gap-1.5 text-xs font-medium sm:text-sm', tone)}>
      {icon}
      <span>{label}</span>
      <span className="sr-only" role="status" aria-live="polite">
        {ANNOUNCE[status]}
      </span>
    </div>
  );
}
