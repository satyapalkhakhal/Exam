// src/pages/admin/Submissions.tsx
// Why: the marking queue (design §8). Filters sit in the column headers. An Evaluator is
// marking blind: the API sends no name/academics, so those columns are not rendered at
// all for that role (branching on admin.role, never on empty data).

import { useState } from 'react';
import { Link } from 'react-router';
import { AdminRole } from '@exam/shared';
import { Badge } from '@/components/ui/badge';
import { ClearFiltersButton } from '@/components/ui/clear-filters-button';
import { Pagination } from '@/components/ui/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TableHeaderFilter, TableHeaderFilterOptions, TableHeaderFilterText } from '@/components/ui/table-header-filter';
import { useRoles } from '@/api/admin/roles';
import { EVALUATION_FILTERS, useSubmissions, type EvaluationFilter, type SubmissionFilters } from '@/api/admin/evaluation';
import { useAdminAuth } from '@/stores/adminAuth';

const PAGE_SIZES = [25, 50, 100];
const EMPTY: SubmissionFilters = { jobRoleId: '', evaluation: '', search: '' };
const EVAL_LABEL: Record<EvaluationFilter, string> = { PENDING: 'Pending', DRAFT: 'Draft', SUBMITTED: 'Evaluated' };

export const formatDuration = (sec: number | null) => (sec === null ? '-' : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`);
export const totalFlags = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
export const flagTitle = (c: Record<string, number>) =>
  Object.entries(c).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`).join(', ');

export default function Submissions() {
  const isSa = useAdminAuth((s) => s.admin?.role) === AdminRole.SUPER_ADMIN;
  const [f, setF] = useState<SubmissionFilters>(EMPTY);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const roles = useRoles();
  const { data, isPending, error } = useSubmissions(f, page, pageSize);
  const set = (patch: Partial<SubmissionFilters>) => {
    setF((c) => ({ ...c, ...patch }));
    setPage(1);
  };
  const activeCount = [f.jobRoleId, f.evaluation, f.search].filter(Boolean).length;
  const cols = isSa ? 9 : 6;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">Submissions</h1>
        <ClearFiltersButton count={activeCount} onClear={() => set(EMPTY)} />
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Code
                  <TableHeaderFilter active={Boolean(f.search)} ariaLabel={isSa ? 'Search by code or name' : 'Search by code'} className="w-56">
                    <TableHeaderFilterText label="Search" value={f.search} onChange={(v) => set({ search: v })} hint={isSa ? 'Candidate code or name' : 'Candidate code'} />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              {isSa && <TableHead>Candidate</TableHead>}
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Role
                  <TableHeaderFilter active={Boolean(f.jobRoleId)} ariaLabel="Filter by role" className="w-72">
                    <TableHeaderFilterOptions value={f.jobRoleId} options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name }))} onChange={(v) => set({ jobRoleId: v })} />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead>Time taken</TableHead>
              <TableHead>Flags</TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Evaluation
                  <TableHeaderFilter active={Boolean(f.evaluation)} ariaLabel="Filter by evaluation status">
                    <TableHeaderFilterOptions
                      value={f.evaluation}
                      options={EVALUATION_FILTERS.map((s) => ({ value: s, label: EVAL_LABEL[s] }))}
                      onChange={(v) => set({ evaluation: v as SubmissionFilters['evaluation'] })}
                    />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              {isSa && <TableHead>Total</TableHead>}
              {isSa && <TableHead>X / XII / CPI</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending && <TableRow><TableCell colSpan={cols} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {data?.items.length === 0 && <TableRow><TableCell colSpan={cols} className="text-muted-foreground">No submissions match.</TableCell></TableRow>}
            {data?.items.map((s) => (
              <TableRow key={s.attemptId}>
                <TableCell className="font-mono text-xs">
                  <Link to={`/admin/submissions/${s.attemptId}`} className="font-medium text-primary hover:underline">{s.candidateCode}</Link>
                </TableCell>
                {isSa && (
                  <TableCell>
                    <div className="font-medium">{s.fullName}</div>
                    <div className="text-xs text-muted-foreground">{s.email}</div>
                  </TableCell>
                )}
                <TableCell>{s.jobRole}</TableCell>
                <TableCell>
                  {s.submittedAt ? new Date(s.submittedAt).toLocaleString() : '-'}
                  {s.submitType === 'AUTO' && <Badge variant="outline" className="ml-1">Auto</Badge>}
                </TableCell>
                <TableCell>{formatDuration(s.timeTakenSec)}</TableCell>
                <TableCell title={flagTitle(s.flagCounts)}>{totalFlags(s.flagCounts) > 0 ? <Badge variant="default">{totalFlags(s.flagCounts)}</Badge> : '-'}</TableCell>
                <TableCell><Badge variant={s.evaluationStatus === 'SUBMITTED' ? 'default' : 'outline'}>{EVAL_LABEL[s.evaluationStatus]}</Badge></TableCell>
                {isSa && <TableCell>{s.totalMarks ?? '-'}</TableCell>}
                {isSa && (
                  <TableCell className="text-xs text-muted-foreground">
                    {s.xPercentage ?? '-'} / {s.xiiPercentage ?? '-'} / {s.majorCpi ?? '-'}
                  </TableCell>
                )}
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
    </div>
  );
}
