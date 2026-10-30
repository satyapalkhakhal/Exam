// src/components/exam/ExamHeader.tsx
// Why: who is sitting the exam, the server-synced countdown and the save state, always in
// view. The countdown colour changes at 10 and 2 minutes; those two moments (not every
// second) are announced to screen readers.

import { Clock } from 'lucide-react';
import type { SaveStatus as Status } from '@/lib/autosave';
import { countdownTone, formatCountdown } from '@/lib/countdown';
import { cn } from '@/lib/utils';
import { SaveStatus } from './SaveStatus';

interface Props {
  name: string;
  code: string;
  role: string;
  remainingMs: number;
  status: Status;
}

const TONE = {
  normal: 'border-border bg-muted/40 text-foreground',
  warning: 'border-amber-300 bg-amber-50 text-amber-800',
  danger: 'border-red-300 bg-red-50 text-red-700',
} as const;

const WARNING = { normal: '', warning: 'Less than 10 minutes left', danger: 'Less than 2 minutes left' } as const;

export function ExamHeader({ name, code, role, remainingMs, status }: Props) {
  const tone = countdownTone(remainingMs);
  return (
    <header className="sticky top-0 z-30 border-b bg-card">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {code} · {role}
          </p>
        </div>
        <div className="flex items-center gap-3 sm:gap-5">
          <SaveStatus status={status} />
          <div
            role="timer"
            className={cn('flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-base font-semibold tabular-nums sm:text-lg', TONE[tone])}
            aria-label={`Time left ${formatCountdown(remainingMs)}`}
          >
            <Clock className="h-4 w-4" aria-hidden="true" />
            <span aria-hidden="true">{formatCountdown(remainingMs)}</span>
          </div>
          <span className="sr-only" role="status" aria-live="assertive">
            {WARNING[tone]}
          </span>
        </div>
      </div>
    </header>
  );
}
