// src/components/exam/McqCard.tsx
// Why: one multiple-choice question (spec 2026-11-10 MCQ questions): four options A–D in the
// order this candidate sees them, one choice, and a way to clear it (an unanswered MCQ never
// loses marks, a wrong one may). The choice is saved at once by the page.

import { MCQ_LETTERS } from '@exam/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function McqCard({
  id,
  label,
  options,
  selected,
  readOnly,
  onChoose,
}: {
  id: string;
  label: string;
  options: string[];
  selected: number | null;
  readOnly: boolean;
  onChoose: (option: number | null) => void;
}) {
  return (
    <fieldset className="space-y-2" aria-label={label}>
      <legend className="sr-only">{label}</legend>
      {options.map((text, i) => {
        const checked = selected === i;
        return (
          <label
            key={i}
            htmlFor={`${id}-${i}`}
            className={cn(
              'flex cursor-pointer select-none items-start gap-3 rounded-lg border bg-card p-3 text-[15px] leading-relaxed transition-colors',
              checked ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:bg-muted/50',
              readOnly && 'cursor-not-allowed opacity-70',
            )}
          >
            <input
              id={`${id}-${i}`}
              type="radio"
              name={id}
              className="mt-1 h-4 w-4 shrink-0 accent-primary"
              checked={checked}
              disabled={readOnly}
              onChange={() => onChoose(i)}
            />
            <span className="font-semibold text-muted-foreground">{MCQ_LETTERS[i]}.</span>
            <span className="min-w-0 flex-1 whitespace-pre-line break-words">{text}</span>
          </label>
        );
      })}
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" disabled={readOnly || selected === null} onClick={() => onChoose(null)}>
          Clear choice
        </Button>
      </div>
    </fieldset>
  );
}
