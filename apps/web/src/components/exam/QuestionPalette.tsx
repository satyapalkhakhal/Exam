// src/components/exam/QuestionPalette.tsx
// Why: free navigation between questions and an at-a-glance view of what is left
// (design 7.4): not visited / visited-unanswered / answered / marked for review / current.

import { cn } from '@/lib/utils';

export type PaletteState = 'not-visited' | 'unanswered' | 'answered' | 'marked';

export interface PaletteItem {
  id: string;
  number: number;
  state: PaletteState;
}

const STYLE: Record<PaletteState, string> = {
  'not-visited': 'border-border bg-background text-muted-foreground',
  unanswered: 'border-amber-300 bg-amber-50 text-amber-800',
  answered: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  marked: 'border-violet-300 bg-violet-50 text-violet-800',
};

const LABEL: Record<PaletteState, string> = {
  'not-visited': 'not visited',
  unanswered: 'visited, not answered',
  answered: 'answered',
  marked: 'marked for review',
};

export interface PaletteSection {
  title: string;
  items: PaletteItem[];
}

export function QuestionPalette({ groups, currentId, onSelect }: { groups: PaletteSection[]; currentId: string; onSelect: (id: string) => void }) {
  // One untitled list when there is only one kind of question.
  const titled = groups.length > 1;
  return (
    <nav aria-label="Questions" className="space-y-3">
      {groups.map((g) => (
        <div key={g.title} className="space-y-1.5">
          {titled && <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</h2>}
          <ol className="flex flex-wrap gap-2" aria-label={titled ? g.title : undefined}>
            {g.items.map((it) => {
              const current = it.id === currentId;
              return (
                <li key={it.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(it.id)}
                    aria-current={current ? 'step' : undefined}
                    aria-label={`Question ${it.number}, ${LABEL[it.state]}${current ? ', current' : ''}`}
                    className={cn(
                      'h-10 w-10 rounded-lg border text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      STYLE[it.state],
                      current && 'ring-2 ring-primary ring-offset-2',
                    )}
                  >
                    {it.number}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        {(Object.keys(STYLE) as PaletteState[]).map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span className={cn('inline-block h-3 w-3 rounded border', STYLE[s])} aria-hidden="true" />
            <span className="capitalize">{LABEL[s]}</span>
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded ring-2 ring-primary" aria-hidden="true" />
          <span>Current</span>
        </li>
      </ul>
    </nav>
  );
}
