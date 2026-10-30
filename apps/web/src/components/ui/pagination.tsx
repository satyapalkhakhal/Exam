import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Shared "Rows per page" choices for the list pages. The backend list schemas
// cap pageSize at 200 to match — raise both together.
export const LIST_PAGE_SIZE_OPTIONS = [50, 100, 200];
export const DEFAULT_LIST_PAGE_SIZE = 50;

export interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  // Opt-in "Rows per page" picker. Both must be passed for it to render; pages
  // that don't pass them look exactly as before.
  pageSizeOptions?: number[];
  onPageSizeChange?: (pageSize: number) => void;
}

// Always includes page 1, the last page, and a window around the current
// page — 'ellipsis' fills the gaps so wide page counts don't render a
// button per page.
function getPageNumbers(page: number, totalPages: number): Array<number | 'ellipsis'> {
  const keep = new Set<number>([1, totalPages, page - 1, page, page + 1]);
  const sorted = [...keep].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  const result: Array<number | 'ellipsis'> = [];
  sorted.forEach((p, i) => {
    const previous = sorted[i - 1];
    if (i > 0 && previous !== undefined && p - previous > 1) result.push('ellipsis');
    result.push(p);
  });
  return result;
}

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  pageSizeOptions,
  onPageSizeChange,
}: PaginationProps) {
  const showPageSize = Boolean(pageSizeOptions?.length && onPageSizeChange);
  // With a size picker the bar stays up even on a single page — otherwise
  // choosing 200 rows would hide the very control needed to go back to 50.
  if (totalPages <= 1 && !showPageSize) return null;

  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-4 pt-4 flex-wrap">
      <div className="flex items-center gap-4 flex-wrap">
        <p className="text-sm text-muted-foreground">
          Showing {rangeStart}-{rangeEnd} of {total}
        </p>
        {showPageSize && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Rows per page
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange?.(Number(e.target.value))}
              className="h-8 rounded-md border border-input bg-background/50 px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {pageSizeOptions?.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          {getPageNumbers(page, totalPages).map((p, i) =>
            p === 'ellipsis' ? (
              <span key={`ellipsis-${i}`} className="px-2 text-sm text-muted-foreground">
                …
              </span>
            ) : (
              <Button
                key={p}
                variant={p === page ? 'default' : 'outline'}
                size="icon"
                onClick={() => onPageChange(p)}
                aria-current={p === page ? 'page' : undefined}
              >
                {p}
              </Button>
            )
          )}
          <Button
            variant="outline"
            size="icon"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
