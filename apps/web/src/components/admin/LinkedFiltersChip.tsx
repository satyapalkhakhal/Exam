// src/components/admin/LinkedFiltersChip.tsx
// Why: filters that arrive in a campus-dashboard link (spec 2026-11-11) but have no column
// control on the list page (batch, round number, …) would otherwise narrow the list invisibly.
// This chip names them and clears them in one click.

import { X } from 'lucide-react';

export function LinkedFiltersChip({ label, onClear }: { label: string; onClear: () => void }) {
  if (!label) return null;
  return (
    <div role="status" className="inline-flex max-w-full items-center gap-2 rounded-full border border-primary/30 bg-primary/10 py-1 pl-3 pr-1 text-sm text-foreground">
      <span className="truncate">From dashboard: {label}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear the dashboard filters"
        className="rounded-full p-1 text-muted-foreground hover:bg-primary/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
