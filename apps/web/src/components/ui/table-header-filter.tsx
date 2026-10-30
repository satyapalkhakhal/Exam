// src/components/ui/table-header-filter.tsx
// A small filter-funnel icon meant to sit inline in a <TableHead>, opening a
// popover anchored to that column instead of a separate filter bar above the
// table. `active` just controls the icon's highlight — callers decide what
// "active" means for their filter (usually: a non-default value is selected).

import * as React from 'react';
import { Filter } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent, PopoverClose } from './popover';
import { Input } from './input';
import { Label } from './label';
import { cn } from '@/lib/utils';

export function TableHeaderFilter({
  active,
  ariaLabel,
  align = 'start',
  className,
  children,
}: {
  active: boolean;
  ariaLabel: string;
  align?: 'start' | 'end' | 'center';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            'inline-flex items-center justify-center rounded p-0.5 transition-colors hover:bg-muted/60 hover:text-foreground',
            active ? 'text-primary' : 'text-muted-foreground/50'
          )}
        >
          <Filter className="w-3 h-3" fill={active ? 'currentColor' : 'none'} />
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className={cn('w-48', className)}>
        {children}
      </PopoverContent>
    </Popover>
  );
}

// The common case: a flat, single-select list of options (Source/Stage/eKYC
// Stage/Status/Call Disposition all use this shape). Picking an option closes
// the popover — PopoverClose, not a plain onClick — so it behaves like
// choosing from a menu rather than a form field left open.
export function TableHeaderFilterOptions({
  value,
  options,
  onChange,
  allLabel = 'All',
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  allLabel?: string;
}) {
  return (
    <div className="max-h-64 overflow-y-auto py-0.5">
      <TableHeaderFilterOption selected={value === ''} label={allLabel} onSelect={() => onChange('')} />
      {options.map((o) => (
        <TableHeaderFilterOption
          key={o.value}
          selected={value === o.value}
          label={o.label}
          onSelect={() => onChange(o.value)}
        />
      ))}
    </div>
  );
}

// Multi-select counterpart to TableHeaderFilterOptions: a checkbox list where
// each click toggles one value and the popover stays open, so several can be
// picked in one go. An empty `value` means "no filter" — the top row clears
// the selection back to that.
export function TableHeaderFilterMultiOptions({
  value,
  options,
  onChange,
  allLabel = 'All',
}: {
  value: string[];
  options: Array<{ value: string; label: string }>;
  onChange: (value: string[]) => void;
  allLabel?: string;
}) {
  const selected = new Set(value);
  const toggle = (optionValue: string) => {
    // Rebuilt in `options` order, so the stored list (and the query key built
    // from it) doesn't depend on the order the boxes were ticked in.
    const next = new Set(selected);
    if (next.has(optionValue)) next.delete(optionValue);
    else next.add(optionValue);
    onChange(options.map((o) => o.value).filter((v) => next.has(v)));
  };

  return (
    <div className="max-h-64 overflow-y-auto py-0.5">
      <button
        type="button"
        onClick={() => onChange([])}
        className={cn(
          'flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted/60',
          value.length === 0 ? 'font-semibold text-primary' : 'text-foreground'
        )}
      >
        {allLabel}
      </button>
      {options.map((o) => {
        const checked = selected.has(o.value);
        return (
          <label
            key={o.value}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted/60',
              checked ? 'font-semibold text-primary' : 'text-foreground'
            )}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(o.value)}
              className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
            />
            <span className="truncate">{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}

// The free-text counterpart to TableHeaderFilterOptions, for columns with no
// closed set of values to list (a custom field of type text/number/date, whose
// values only exist in captured data). Debounced on the same 300ms as
// LeadSearchBar so typing doesn't fire a request per keystroke.
//
// Deliberately no "resync draft when `value` changes externally" effect: this
// body is rendered inside a PopoverContent, which unmounts on close, so it is
// re-seeded from `value` on every open and can never drift.
const TEXT_FILTER_DEBOUNCE_MS = 300;

export function TableHeaderFilterText({
  value,
  onChange,
  label,
  inputType = 'text',
  hint,
  autoFocus = true,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  inputType?: 'text' | 'number' | 'date';
  hint?: string;
  // Off for every input but the first when a popover stacks several.
  autoFocus?: boolean;
}) {
  const inputId = React.useId();
  const [draft, setDraft] = React.useState(value);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the debounce still owes the caller. Closing the popover unmounts this
  // input, which would otherwise silently discard a term the user typed and
  // then clicked away from before the timer fired.
  const pendingRef = React.useRef<string | null>(null);
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  });

  React.useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (pendingRef.current !== null) onChangeRef.current(pendingRef.current);
    },
    []
  );

  const commit = (next: string) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    pendingRef.current = null;
    onChangeRef.current(next);
  };

  const handleChange = (next: string) => {
    setDraft(next);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    // Clearing snaps back to the unfiltered list immediately rather than after
    // the delay — same rule LeadSearchBar follows.
    if (next.trim() === '') {
      pendingRef.current = null;
      onChangeRef.current('');
      return;
    }
    pendingRef.current = next.trim();
    timeoutRef.current = setTimeout(() => commit(next.trim()), TEXT_FILTER_DEBOUNCE_MS);
  };

  return (
    <div className="p-1.5 space-y-1.5">
      <Label
        htmlFor={inputId}
        className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70"
      >
        {label}
      </Label>
      <Input
        id={inputId}
        type={inputType}
        value={draft}
        autoFocus={autoFocus}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(draft.trim());
          }
        }}
        {...(inputType === 'text' ? { placeholder: 'Type to filter...' } : {})}
      />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function TableHeaderFilterOption({
  selected,
  label,
  onSelect,
}: {
  selected: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <PopoverClose asChild>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted/60',
          selected ? 'font-semibold text-primary' : 'text-foreground'
        )}
      >
        {label}
      </button>
    </PopoverClose>
  );
}
