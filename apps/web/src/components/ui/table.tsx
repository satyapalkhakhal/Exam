// src/components/ui/table.tsx

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

const FADE_WIDTH = 'w-10';

// A wide table's only hint that more columns exist is the horizontal scrollbar,
// which sits below 20 rows of data — so nothing on screen tells you until you
// scroll down and go looking for it. These edge affordances say it up front: a
// fade gradient on whichever side still has hidden content, plus an arrow to
// page through it. Both derive from live scroll position, so a table that fits
// its container renders neither and looks exactly as it did before.
function useColumnScroll() {
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = React.useState(false);
  const [canRight, setCanRight] = React.useState(false);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const sync = () => {
      // 1px tolerance: fractional layout widths (browser zoom, fit-content
      // columns) otherwise leave scrollLeft a hair short of the maximum and
      // strand a right arrow that can no longer move anything.
      const max = el.scrollWidth - el.clientWidth;
      setCanLeft(el.scrollLeft > 1);
      setCanRight(el.scrollLeft < max - 1);
    };

    sync();
    el.addEventListener('scroll', sync, { passive: true });

    // The scroller's own box changes on window/sidebar resize; the <table>
    // inside it changes when its natural width does — a filter narrowing the
    // data, a column of longer values arriving. Observing both covers either.
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);

    return () => {
      el.removeEventListener('scroll', sync);
      observer.disconnect();
    };
  }, []);

  // 80% of a viewport rather than a full one, so a column carries over between
  // jumps and you keep your bearings instead of landing on unfamiliar headers.
  const scrollColumns = React.useCallback((direction: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: 'smooth' });
  }, []);

  return { scrollerRef, canLeft, canRight, scrollColumns };
}

const ScrollFade = ({ side }: { side: 'left' | 'right' }) => (
  <div
    aria-hidden
    className={cn(
      'pointer-events-none absolute inset-y-0 z-10',
      FADE_WIDTH,
      side === 'left' ? 'left-0 bg-gradient-to-r from-card' : 'right-0 bg-gradient-to-l from-card'
    )}
  />
);

const ScrollArrow = ({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={`Scroll columns ${side}`}
    className={cn(
      // Parked in the header band (TableHead is h-11, so top-1.5 centres a
      // 32px button in it) rather than centred over the rows: at 20 rows a
      // vertically-centred arrow lands below the fold, which is the very
      // problem this is here to solve.
      'absolute top-1.5 z-20 grid h-8 w-8 place-items-center rounded-full',
      'border border-border bg-card text-muted-foreground shadow-dropdown',
      'transition-colors hover:bg-muted hover:text-foreground',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      side === 'left' ? 'left-1' : 'right-1'
    )}
  >
    {side === 'left' ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
  </button>
);

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => {
    const { scrollerRef, canLeft, canRight, scrollColumns } = useColumnScroll();

    return (
      <div className="relative w-full">
        {/* `relative`: the scroller must be the containing block for anything
            absolutely positioned inside the table. Without it, an `sr-only`
            header label (absolute) resolves against the wrapper OUTSIDE this
            scroller, escapes its clipping, and sits at the table's far right —
            stretching the PAGE's scroll width to the full table width, so the
            page itself scrolled into blank space.
            `overscroll-x-contain`: a horizontal wheel/trackpad scroll that
            reaches the table's edge stops there instead of chaining on to the
            page. */}
        <div ref={scrollerRef} className="relative w-full overflow-x-auto overscroll-x-contain">
          {/* min-w-max keeps the table at its natural content width instead of
              shrinking columns to fit the container - that's what actually
              triggers the wrapper's overflow-x-auto scrollbar on wide tables. */}
          <table ref={ref} className={cn('w-full min-w-max caption-bottom text-sm', className)} {...props} />
        </div>
        {canLeft && (
          <>
            <ScrollFade side="left" />
            <ScrollArrow side="left" onClick={() => scrollColumns(-1)} />
          </>
        )}
        {canRight && (
          <>
            <ScrollFade side="right" />
            <ScrollArrow side="right" onClick={() => scrollColumns(1)} />
          </>
        )}
      </div>
    );
  }
);
Table.displayName = 'Table';

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <thead ref={ref} className={cn('border-b border-border', className)} {...props} />
  )
);
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
  )
);
TableBody.displayName = 'TableBody';

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn('border-b border-border/60 transition-colors hover:bg-muted/40', className)}
      {...props}
    />
  )
);
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        'h-11 px-4 text-left align-middle text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70',
        className
      )}
      {...props}
    />
  )
);
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn('px-4 py-3 align-middle text-foreground', className)} {...props} />
  )
);
TableCell.displayName = 'TableCell';

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
