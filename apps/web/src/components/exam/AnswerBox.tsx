// src/components/exam/AnswerBox.tsx
// Why: the plain-text answer area (design 7.4). It reports, with every change, how many
// characters were actually *typed* (native beforeinput, capped per event; IME text once, as
// the net growth of the composition), and separately how many Undo/Redo brought back (never
// more than was deleted, see createRestoreBudget), which the server compares with the answer's growth. Paste blocking lives in the page-wide
// guard. The 20,000-character cap is visible before it bites, never a silent truncation.

import { useEffect, useRef } from 'react';
import { countWords } from '@exam/shared';
import { compositionTypedChars, createRestoreBudget, typedCharsFor } from '@/lib/pasteGuard';
import { ANSWER_MAX_CHARS } from '@/types/exam';
import { cn } from '@/lib/utils';

interface Props {
  id: string;
  label: string;
  value: string;
  readOnly: boolean;
  onChange: (text: string, typedDelta: number, restoredDelta: number) => void;
}

const fmt = (n: number) => n.toLocaleString('en-IN');
const LIMIT_WARN_AT = ANSWER_MAX_CHARS - 1000;

export function AnswerBox({ id, label, value, readOnly, onChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const typed = useRef(0);
  // Keyed per question by the page, so the bank never crosses answers.
  const restore = useRef(createRestoreBudget());
  const lastInputType = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onBeforeInput = (e: Event) => {
      const ie = e as InputEvent;
      if (!e.defaultPrevented) typed.current += typedCharsFor(ie.inputType, ie.data);
    };
    // The native input event (fired before React's onChange) carries the inputType in every
    // browser, including Undo/Redo where some never fire beforeinput.
    const onInput = (e: Event) => {
      lastInputType.current = (e as InputEvent).inputType ?? null;
    };
    // Net growth across the composition, not its data: re-committing an existing word adds 0.
    let lengthAtStart = el.value.length;
    const onCompositionStart = () => {
      lengthAtStart = el.value.length;
    };
    const onCompositionEnd = () => {
      onChangeRef.current(el.value, compositionTypedChars(lengthAtStart, el.value.length), 0);
    };
    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('input', onInput);
    el.addEventListener('compositionstart', onCompositionStart);
    el.addEventListener('compositionend', onCompositionEnd);
    return () => {
      el.removeEventListener('beforeinput', onBeforeInput);
      el.removeEventListener('input', onInput);
      el.removeEventListener('compositionstart', onCompositionStart);
      el.removeEventListener('compositionend', onCompositionEnd);
    };
  }, []);

  const words = countWords(value);
  const left = ANSWER_MAX_CHARS - value.length;

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        id={id}
        ref={ref}
        value={value}
        readOnly={readOnly}
        maxLength={ANSWER_MAX_CHARS}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-describedby={`${id}-count ${id}-limit`}
        placeholder="Type your answer here…"
        onChange={(e) => {
          const delta = typed.current;
          typed.current = 0;
          const restored = restore.current.apply(lastInputType.current, value.length, e.target.value.length);
          lastInputType.current = null;
          onChange(e.target.value, delta, restored);
        }}
        className="block min-h-[50vh] w-full resize-y rounded-lg border border-input bg-background px-4 py-3 text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring read-only:bg-muted/40"
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p id={`${id}-count`} className={cn('font-medium', words > 1500 ? 'text-amber-700' : 'text-muted-foreground')}>
          {fmt(words)} words · target 1,000–1,500
        </p>
        <p id={`${id}-limit`} aria-live="polite" className={cn(left <= 0 ? 'text-destructive' : 'text-amber-700')}>
          {left <= 0
            ? `This answer has reached the ${fmt(ANSWER_MAX_CHARS)}-character limit.`
            : value.length >= LIMIT_WARN_AT
              ? `${fmt(left)} characters left in this answer.`
              : ''}
        </p>
      </div>
    </div>
  );
}
