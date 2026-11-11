// src/pages/admin/Submissions.tsx
// Why: the marking queue (design §8). Filters sit in the column headers. An Evaluator is
// marking blind: the API sends no name/academics, so those columns are not rendered at
// all for that role (branching on admin.role, never on empty data).

import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useColleges } from '@/api/admin/drives';
import { LinkedFiltersChip } from '@/components/admin/LinkedFiltersChip';
import { LINK_FILTER_VALIDATORS, filtersFromSearch, linkedFilterLabel } from '@/lib/urlFilters';
import { AdminRole } from '@exam/shared';
import { AI_FILTERS } from '@exam/shared';
import { AiSubmissionsToolbar } from '@/components/admin/AiSubmissionsToolbar';
import { Checkbox } from '@/components/ui/checkbox';
import { AI_FILTER_LABEL, aiStateBadge } from '@/lib/aiEvaluation';
import { mcqCell } from '@/lib/marking';
import { Badge } from '@/components/ui/badge';
import { ClearFiltersButton } from '@/components/ui/clear-filters-button';
import { Pagination } from '@/components/ui/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TableHeaderFilter, TableHeaderFilterOptions, TableHeaderFilterText } from '@/components/ui/table-header-filter';
import { useRoles } from '@/api/admin/roles';
import { allDrives, jobProfileLabel, roundOptions } from '@/lib/drivePicker';
import { EVALUATION_FILTERS, useSubmissions, type EvaluationFilter, type SubmissionFilters } from '@/api/admin/evaluation';
import { useAdminAuth } from '@/stores/adminAuth';

const PAGE_SIZES = [25, 50, 100];
const EMPTY: SubmissionFilters = {
  jobRoleId: '', roundId: '', driveId: '', collegeId: '', batch: '', jobProfileType: '', roundNumber: '', evaluation: '', ai: '', search: '',
};
// An Evaluator never takes a college or batch from a link: the API refuses them (blind marking).
const { collegeId: _college, batch: _batch, ...BLIND_LINK_VALIDATORS } = LINK_FILTER_VALIDATORS;
const EVAL_LABEL: Record<EvaluationFilter, string> = { PENDING: 'Pending', DRAFT: 'Draft', SUBMITTED: 'Evaluated' };

export const formatDuration = (sec: number | null) => (sec === null ? '-' : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`);
export const totalFlags = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
export const flagTitle = (c: Record<string, number>) =>
  Object.entries(c).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`).join(', ');

export default function Submissions() {
  const isSa = useAdminAuth((s) => s.admin?.role) === AdminRole.SUPER_ADMIN;
  const location = useLocation();
  const colleges = useColleges(isSa);
  // Starting filters may come from a campus-dashboard link (validated keys only).
  const [f, setF] = useState<SubmissionFilters>(() => filtersFromSearch(location.search, EMPTY, isSa ? LINK_FILTER_VALIDATORS : BLIND_LINK_VALIDATORS));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<string[]>([]);
  const roles = useRoles();
  const { data, isPending, error } = useSubmissions(f, page, pageSize);
  const set = (patch: Partial<SubmissionFilters>) => {
    setF((c) => ({ ...c, ...patch }));
    setPage(1);
    setSelected([]);
  };
  const activeCount = [f.jobRoleId, f.roundId, f.driveId, f.collegeId, f.batch, f.jobProfileType, f.roundNumber, f.evaluation, f.ai, f.search].filter(Boolean).length;
  const linkedLabel = linkedFilterLabel({
    collegeName: f.collegeId ? (colleges.data?.find((c) => c.id === f.collegeId)?.shortCode ?? 'Selected college') : undefined,
    batch: f.batch,
    roundNumber: f.roundNumber,
    jobProfileType: f.jobProfileType,
  });
  const cols = isSa ? 14 : 10;
  const rowsIds = data?.items.map((s) => s.attemptId) ?? [];
  const allSelected = rowsIds.length > 0 && rowsIds.every((id) => selected.includes(id));
  const toggle = (id: string) => setSelected((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">Submissions</h1>
        <div className="flex flex-wrap items-center gap-2">
          {/* College, batch, round number and programme have no column filter here. */}
          <LinkedFiltersChip label={linkedLabel} onClear={() => set({ collegeId: '', batch: '', jobProfileType: '', roundNumber: '' })} />
          <ClearFiltersButton count={activeCount} onClear={() => set(EMPTY)} />
        </div>
      </div>
      {isSa && (
        <AiSubmissionsToolbar
          driveId={f.driveId}
          total={data?.total ?? 0}
          selectedIds={selected}
          selectedDriveNames={(data?.items ?? []).filter((s) => selected.includes(s.attemptId)).map((s) => s.driveDisplayName)}
          onClearSelection={() => setSelected([])}
        />
      )}
      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              {isSa && (
                <TableHead className="w-8">
                  <Checkbox aria-label="Select all rows on this page" checked={allSelected} onChange={(e) => setSelected((c) => (e.target.checked ? [...new Set([...c, ...rowsIds])] : c.filter((id) => !rowsIds.includes(id))))} />
                </TableHead>
              )}
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Code
                  <TableHeaderFilter active={Boolean(f.search)} ariaLabel={isSa ? 'Search by code, name, roll number or email' : 'Search by code'} className="w-56">
                    <TableHeaderFilterText label="Search" value={f.search} onChange={(v) => set({ search: v })} hint={isSa ? 'Code, name, roll number or email' : 'Candidate code'} />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              {isSa && <TableHead>Candidate</TableHead>}
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Job profile
                  <TableHeaderFilter active={Boolean(f.jobRoleId || f.roundId || f.driveId)} ariaLabel={isSa ? 'Filter by job profile, round or drive' : 'Filter by job profile or round'} className="w-80">
                    <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">Job profile</p>
                    <TableHeaderFilterOptions value={f.jobRoleId} options={(roles.data ?? []).map((r) => ({ value: r.id, label: jobProfileLabel(r) }))} onChange={(v) => set({ jobRoleId: v })} />
                    <p className="px-2 pt-2 text-xs font-medium text-muted-foreground">Round</p>
                    <TableHeaderFilterOptions value={f.roundId} options={roundOptions(roles.data ?? []).map((o) => ({ value: o.id, label: o.label }))} onChange={(v) => set({ roundId: v })} />
                    {/* Blind marking: only a Super Admin may narrow by drive (college + batch). */}
                    {isSa && (
                      <>
                        <p className="px-2 pt-2 text-xs font-medium text-muted-foreground">Drive</p>
                        <TableHeaderFilterOptions value={f.driveId} options={allDrives(roles.data ?? []).map((d) => ({ value: d.id, label: d.displayName }))} onChange={(v) => set({ driveId: v })} />
                      </>
                    )}
                  </TableHeaderFilter>
                </span>
              </TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead>Time taken</TableHead>
              <TableHead>Flags</TableHead>
              <TableHead title="Other candidates who started the exam within 100 m and 2 hours">Nearby</TableHead>
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
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  AI
                  <TableHeaderFilter active={Boolean(f.ai)} ariaLabel="Filter by AI status">
                    <TableHeaderFilterOptions
                      value={f.ai}
                      options={AI_FILTERS.map((s) => ({ value: s, label: AI_FILTER_LABEL[s] }))}
                      onChange={(v) => set({ ai: v as SubmissionFilters['ai'] })}
                    />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              <TableHead>AI %</TableHead>
              <TableHead title="Multiple-choice marks (auto-marked at submit)">MCQ</TableHead>
              {isSa && <TableHead>Total</TableHead>}
              {isSa && <TableHead>X / XII / CPI</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending && <TableRow><TableCell colSpan={cols} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {data?.items.length === 0 && <TableRow><TableCell colSpan={cols} className="text-muted-foreground">No submissions match.</TableCell></TableRow>}
            {data?.items.map((s) => (
              <TableRow key={s.attemptId}>
                {isSa && (
                  <TableCell>
                    <Checkbox aria-label={`Select ${s.candidateCode}`} checked={selected.includes(s.attemptId)} onChange={() => toggle(s.attemptId)} />
                  </TableCell>
                )}
                <TableCell className="font-mono text-xs">
                  <Link to={`/admin/submissions/${s.attemptId}`} className="font-medium text-primary hover:underline">{s.candidateCode}</Link>
                </TableCell>
                {isSa && (
                  <TableCell>
                    <div className="font-medium">{s.fullName}</div>
                    <div className="text-xs text-muted-foreground">{s.email}</div>
                  </TableCell>
                )}
                <TableCell>
                  {s.jobRole}
                  {s.jobProfileType === 'INTERNSHIP' && <Badge variant="secondary" className="ml-1">Internship</Badge>}
                  <div className="text-xs text-muted-foreground">{isSa && s.driveDisplayName ? s.driveDisplayName.slice(s.jobRole.length + 3) : `Round ${s.roundNumber}`}</div>
                </TableCell>
                <TableCell>
                  {s.submittedAt ? new Date(s.submittedAt).toLocaleString() : '-'}
                  {s.submitType === 'AUTO' && <Badge variant="outline" className="ml-1">Auto</Badge>}
                </TableCell>
                <TableCell>{formatDuration(s.timeTakenSec)}</TableCell>
                <TableCell title={flagTitle(s.flagCounts)}>{totalFlags(s.flagCounts) > 0 ? <Badge variant="default">{totalFlags(s.flagCounts)}</Badge> : '-'}</TableCell>
                <TableCell>{s.nearbyCount ?? '-'}</TableCell>
                <TableCell><Badge variant={s.evaluationStatus === 'SUBMITTED' ? 'default' : 'outline'}>{EVAL_LABEL[s.evaluationStatus]}</Badge></TableCell>
                <TableCell><Badge variant={aiStateBadge(s.ai).variant}>{aiStateBadge(s.ai).label}</Badge></TableCell>
                <TableCell>{s.ai.percentage ?? '-'}</TableCell>
                <TableCell className="whitespace-nowrap">{mcqCell(s)}</TableCell>
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
