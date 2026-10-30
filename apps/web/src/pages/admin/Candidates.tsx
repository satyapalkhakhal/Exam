// src/pages/admin/Candidates.tsx
// Why: Super Admin's candidate list (design §6.2). Filters (search, role, status,
// flagged) sit in the column headers; the academic columns sort. A row opens the detail
// page. The import wizard lives in a dialog so the list stays the page's focus.

import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { ImportWizard } from '@/components/import/ImportWizard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClearFiltersButton } from '@/components/ui/clear-filters-button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { TableHeaderFilter, TableHeaderFilterOptions, TableHeaderFilterText } from '@/components/ui/table-header-filter';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useRoles } from '@/api/admin/roles';
import {
  CANDIDATE_STATUSES,
  CANDIDATE_TEMPLATE_URL,
  confirmCandidateImport,
  previewCandidateImport,
  useCandidates,
  type CandidateFilters,
  type CandidateSort,
} from '@/api/admin/candidates';

export const statusText = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

// The API caps pageSize at 100 (plan Task 9), so the shared 200 option is not offered.
const PAGE_SIZES = [25, 50, 100];
const EMPTY: CandidateFilters = { search: '', jobRoleId: '', status: '', flagged: '', sort: 'createdAt', dir: 'desc' };

function SortHead({ label, field, f, onSort }: { label: string; field: CandidateSort; f: CandidateFilters; onSort: (s: CandidateSort) => void }) {
  const active = f.sort === field;
  const Icon = !active ? ArrowUpDown : f.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead aria-sort={active ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(field)} className="inline-flex items-center gap-1 hover:text-foreground">
        {label}
        <Icon className={`h-3 w-3 ${active ? 'text-primary' : 'text-muted-foreground/50'}`} />
      </button>
    </TableHead>
  );
}

export default function Candidates() {
  const [f, setF] = useState<CandidateFilters>(EMPTY);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [importing, setImporting] = useState(false);
  const roles = useRoles();
  const { data, isPending, error } = useCandidates(f, page, pageSize);
  const qc = useQueryClient();

  const set = (patch: Partial<CandidateFilters>) => {
    setF((c) => ({ ...c, ...patch }));
    setPage(1);
  };
  const onSort = (s: CandidateSort) => set(f.sort === s ? { dir: f.dir === 'asc' ? 'desc' : 'asc' } : { sort: s, dir: 'asc' });
  const activeCount = [f.search, f.jobRoleId, f.status, f.flagged].filter(Boolean).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">Candidates</h1>
        <div className="flex items-center gap-2">
          <ClearFiltersButton count={activeCount} onClear={() => set({ search: '', jobRoleId: '', status: '', flagged: '' })} />
          <Button onClick={() => setImporting(true)}>Import candidates</Button>
        </div>
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  <button type="button" onClick={() => onSort('fullName')} className="hover:text-foreground" aria-label="Sort by name">Name</button>
                  <TableHeaderFilter active={Boolean(f.search)} ariaLabel="Search by name, email, roll number or code" className="w-56">
                    <TableHeaderFilterText label="Search" value={f.search} onChange={(v) => set({ search: v })} hint="Name, email, roll number or code" />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Role
                  <TableHeaderFilter active={Boolean(f.jobRoleId)} ariaLabel="Filter by role" className="w-72">
                    <TableHeaderFilterOptions value={f.jobRoleId} options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name }))} onChange={(v) => set({ jobRoleId: v })} />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Status
                  <TableHeaderFilter active={Boolean(f.status)} ariaLabel="Filter by status">
                    <TableHeaderFilterOptions value={f.status} options={CANDIDATE_STATUSES.map((s) => ({ value: s, label: statusText(s) }))} onChange={(v) => set({ status: v })} />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              <SortHead label="X %" field="xPercentage" f={f} onSort={onSort} />
              <SortHead label="XII %" field="xiiPercentage" f={f} onSort={onSort} />
              <SortHead label="CPI" field="majorCpi" f={f} onSort={onSort} />
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Flags
                  <TableHeaderFilter active={Boolean(f.flagged)} ariaLabel="Filter by flagged">
                    <TableHeaderFilterOptions
                      value={f.flagged}
                      options={[{ value: 'true', label: 'Flagged only' }, { value: 'false', label: 'Not flagged' }]}
                      onChange={(v) => set({ flagged: v as CandidateFilters['flagged'] })}
                    />
                  </TableHeaderFilter>
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending && <TableRow><TableCell colSpan={8} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {data?.items.length === 0 && <TableRow><TableCell colSpan={8} className="text-muted-foreground">No candidates match.</TableCell></TableRow>}
            {data?.items.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono text-xs">{c.candidateCode}</TableCell>
                <TableCell>
                  <Link to={`/admin/candidates/${c.id}`} className="font-medium text-primary hover:underline">{c.fullName}</Link>
                  <div className="text-xs text-muted-foreground">{c.email}</div>
                </TableCell>
                <TableCell>{c.jobRoleName}</TableCell>
                <TableCell>
                  <Badge variant="outline">{statusText(c.status)}</Badge>
                  {!c.eligible && <Badge variant="outline" className="ml-1">Not eligible</Badge>}
                </TableCell>
                <TableCell>{c.xPercentage ?? '-'}</TableCell>
                <TableCell>{c.xiiPercentage ?? '-'}</TableCell>
                <TableCell>{c.majorCpi ?? '-'}</TableCell>
                <TableCell>{c.flagCount > 0 ? <Badge variant="default">{c.flagCount}</Badge> : '-'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {data && (
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          totalPages={Math.max(1, Math.ceil(data.total / data.pageSize))}
          onPageChange={setPage}
          pageSizeOptions={PAGE_SIZES}
          onPageSizeChange={(n) => {
            setPageSize(n);
            setPage(1);
          }}
        />
      )}
      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Import candidates</DialogTitle>
            <DialogDescription>Rows with an existing or repeated email or mobile are flagged and skipped.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            <ImportWizard
              kind="CANDIDATES"
              jobRoles={roles.data ?? []}
              templateUrl={CANDIDATE_TEMPLATE_URL}
              previewFn={previewCandidateImport}
              confirmFn={confirmCandidateImport}
              onImported={() => void qc.invalidateQueries({ queryKey: ['admin'] })}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
