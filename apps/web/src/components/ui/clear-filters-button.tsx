// src/components/ui/clear-filters-button.tsx
// The list pages' escape hatch from sticky filters (see lib/listFilterStore).
// Because a filter now survives navigation, something on screen has to say so
// and offer a way out — this is both. It renders nothing when no filter is
// applied, so an unfiltered table carries no dead chrome.

import { FilterX } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ClearFiltersButton({ count, onClear }: { count: number; onClear: () => void }) {
  if (count === 0) return null;

  return (
    <Button variant="outline" size="sm" onClick={onClear} className="gap-1.5">
      <FilterX className="w-3.5 h-3.5" />
      Clear filters ({count})
    </Button>
  );
}
