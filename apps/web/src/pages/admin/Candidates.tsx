// src/pages/admin/Candidates.tsx
// Why: Super Admin's candidate list (design §6.2). Filters (search, role, status, result,
// flagged, and Min boxes on X % / XII % / CPI / Marks) sit in the column headers; the
// academic, time-taken and marks columns sort. Selected candidates can be shortlisted or
// rejected (which also sends the email), emailed, or moved to another job profile; "select
// all matching" selects every page. A row opens the detail page. The import wizard lives
// in a dialog so the list stays the page's focus.

import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { LinkedFiltersChip } from '@/components/admin/LinkedFiltersChip';
import { LINK_FILTER_VALIDATORS, filtersFromSearch, linkedFilterLabel } from '@/lib/urlFilters';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { ImportWizard } from '@/components/import/ImportWizard';
import { AddCandidateDialog } from '@/components/admin/AddCandidateDialog';
import { SendEmailDialog } from '@/components/admin/SendEmailDialog';
import { MoveToDriveDialog } from '@/components/admin/MoveToDriveDialog';
import { DecisionDialog } from '@/components/admin/DecisionDialog';
import { RESULT_TEXT, ResultBadge } from '@/components/admin/ResultBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClearFiltersButton } from '@/components/ui/clear-filters-button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { TableHeaderFilter, TableHeaderFilterOptions, TableHeaderFilterText } from '@/components/ui/table-header-filter';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useRoles } from '@/api/admin/roles';
import { useColleges } from '@/api/admin/drives';
import { allDrives, batchOf, jobProfileLabel, roundOptions } from '@/lib/drivePicker';
import { JOB_PROFILE_TYPE_LABELS } from '@exam/shared';
import {
  CANDIDATE_STATUSES,
  CANDIDATE_TEMPLATE_URL,
  confirmCandidateImport,
  fetchMatchingCandidateIds,
  previewCandidateImport,
  useCandidates,
  type CandidateFilters,
  type CandidateListItem,
  type CandidateResult,
  type CandidateSort,
} from '@/api/admin/candidates';
import { EMPTY_CANDIDATE_FILTERS, FILTER_KEYS, marksText } from '@/lib/candidateQuery';
import { timeTaken } from '@/lib/submissionReceipt';

export const statusText = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

// The API caps pageSize at 100 (plan Task 9), so the shared 200 option is not offered.
const PAGE_SIZES = [25, 50, 100];
const CLEARED = Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])) as Pick<CandidateFilters, (typeof FILTER_KEYS)[number]>;
type MinKey = 'xMin' | 'xiiMin' | 'cpiMin' | 'marksPctMin';

/** A sortable column header, optionally with a "Min" filter box. */
function SortHead({
  label,
  field,
  f,
  onSort,
  min,
}: {
  label: string;
  field: CandidateSort;
  f: CandidateFilters;
  onSort: (s: CandidateSort) => void;
  min?: { key: MinKey; label: string; hint: string; onChange: (key: MinKey, v: string) => void };
}) {
  const active = f.sort === field;
  const Icon = !active ? ArrowUpDown : f.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead aria-sort={active ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <span className="inline-flex items-center gap-1.5">
        <button type="button" onClick={() => onSort(field)} className="inline-flex items-center gap-1 hover:text-foreground">
          {label}
          <Icon className={`h-3 w-3 ${active ? 'text-primary' : 'text-muted-foreground/50'}`} />
        </button>
        {min && (
          <TableHeaderFilter active={f[min.key] !== ''} ariaLabel={`Minimum ${label}`} className="w-52">
            <TableHeaderFilterText label={min.label} inputType="number" value={f[min.key]} onChange={(v) => min.onChange(min.key, v)} hint={min.hint} />
          </TableHeaderFilter>
        )}
      </span>
    </TableHead>
  );
}

/** "Also applied: Backend Engineer (Rejected), Data Analyst (Submitted)". */
const otherAppsText = (c: CandidateListItem) =>
  c.otherApplications.map((o) => `${o.driveDisplayName} (${o.result ? RESULT_TEXT[o.result] : statusText(o.status)})`).join(', ');

export default function Candidates() {
  const location = useLocation();
  // Starting filters may come from a campus-dashboard link (validated keys only).
  const [f, setF] = useState<CandidateFilters>(() => filtersFromSearch(location.search, EMPTY_CANDIDATE_FILTERS, LINK_FILTER_VALIDATORS));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  // Ticked candidates, kept across pages and filter changes so several pages can be moved together.
  const [emailing, setEmailing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Drive of each ticked candidate, so the decision dialog can say when a selection spans several.
  const [driveOf, setDriveOf] = useState<Map<string, string>>(() => new Map());
  const [moving, setMoving] = useState(false);
  const [deciding, setDeciding] = useState<CandidateResult | null>(null);
  const [matching, setMatching] = useState<{ loading: boolean; error: string | null; total: number | null }>({ loading: false, error: null, total: null });
  const roles = useRoles();
  const colleges = useColleges();
  const { data, isPending, error } = useCandidates(f, page, pageSize);
  const qc = useQueryClient();

  const set = (patch: Partial<CandidateFilters>) => {
    setF((c) => ({ ...c, ...patch }));
    setPage(1);
    // "All N matching are selected" described the old filters.
    setMatching({ loading: false, error: null, total: null });
  };
  const onSort = (s: CandidateSort) => set(f.sort === s ? { dir: f.dir === 'asc' ? 'desc' : 'asc' } : { sort: s, dir: 'asc' });
  const setMin = (key: MinKey, v: string) => set({ [key]: v } as Partial<CandidateFilters>);
  const activeCount = FILTER_KEYS.filter((k) => f[k] !== '').length;
  const pageIds = data?.items.map((c) => c.id) ?? [];
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const driveCount = new Set([...selected].map((id) => driveOf.get(id)).filter(Boolean)).size;
  const clearSelection = () => {
    setSelected(new Set());
    setMatching({ loading: false, error: null, total: null });
  };
  const toggle = (c: CandidateListItem) => {
    setMatching((m) => ({ ...m, total: null }));
    setDriveOf((cur) => new Map(cur).set(c.id, c.driveId));
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
  };
  const togglePage = () => {
    setMatching((m) => ({ ...m, total: null }));
    setDriveOf((cur) => {
      const next = new Map(cur);
      for (const c of data?.items ?? []) next.set(c.id, c.driveId);
      return next;
    });
    setSelected((cur) => {
      const next = new Set(cur);
      for (const id of pageIds) {
        if (allOnPage) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };
  const selectAllMatching = async () => {
    setMatching({ loading: true, error: null, total: null });
    try {
      const r = await fetchMatchingCandidateIds(f);
      setDriveOf((cur) => {
        const next = new Map(cur);
        for (const [id, driveId] of Object.entries(r.driveIdById)) next.set(id, driveId);
        return next;
      });
      setSelected(new Set(r.ids));
      setMatching({ loading: false, error: null, total: r.total });
    } catch (err) {
      setMatching({ loading: false, error: err instanceof Error ? err.message : 'Could not select all matching candidates', total: null });
    }
  };
  const offerAll = allOnPage && data !== undefined && data.total > pageIds.length && matching.total === null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">Candidates</h1>
        <div className="flex items-center gap-2">
          {/* College, profile and programme have column filters; batch and round number do not. */}
          <LinkedFiltersChip label={linkedFilterLabel({ batch: f.batch, roundNumber: f.roundNumber })} onClear={() => set({ batch: '', roundNumber: '' })} />
          <ClearFiltersButton count={activeCount} onClear={() => set(CLEARED)} />
          {selected.size > 0 && (
            <>
              <span className="text-sm text-muted-foreground">{selected.size} selected</span>
              <Button variant="ghost" size="sm" onClick={clearSelection}>Clear</Button>
              <Button variant="outline" onClick={() => setDeciding('SHORTLISTED')}>Shortlist</Button>
              <Button variant="outline" onClick={() => setDeciding('REJECTED')}>Reject</Button>
              <Button variant="outline" onClick={() => setMoving(true)}>Move to drive</Button>
              <Button variant="outline" onClick={() => setEmailing(true)}>Send email</Button>
            </>
          )}
          <Button variant="outline" onClick={() => setAdding(true)}>Add candidate</Button>
          <Button onClick={() => setImporting(true)}>Import candidates</Button>
        </div>
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
      {(offerAll || matching.total !== null || matching.error) && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm" role="status">
          {matching.total !== null ? (
            <>
              <span>All {matching.total} matching candidates are selected.</span>
              <Button variant="link" size="sm" className="h-auto p-0" onClick={clearSelection}>Clear selection</Button>
            </>
          ) : matching.error ? (
            <span className="text-destructive">{matching.error}</span>
          ) : (
            <>
              <span>All {pageIds.length} on this page are selected.</span>
              <Button variant="link" size="sm" className="h-auto p-0" disabled={matching.loading} onClick={() => void selectAllMatching()}>
                {matching.loading ? 'Selecting…' : `Select all ${data?.total ?? 0} matching candidates`}
              </Button>
            </>
          )}
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input type="checkbox" className="h-4 w-4 accent-primary" aria-label="Select all candidates on this page" checked={allOnPage} onChange={togglePage} />
              </TableHead>
              <TableHead>Code</TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  <button type="button" onClick={() => onSort('fullName')} className="hover:text-foreground" aria-label="Sort by name">Name</button>
                  <TableHeaderFilter active={Boolean(f.search)} ariaLabel="Search by name, email, roll number, mobile or code" className="w-56">
                    <TableHeaderFilterText label="Search" value={f.search} onChange={(v) => set({ search: v })} hint="Name, email, roll number, mobile or code" />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Job profile
                  <TableHeaderFilter active={Boolean(f.jobRoleId || f.jobProfileType)} ariaLabel="Filter by job profile or type" className="w-72">
                    <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">Type</p>
                    <TableHeaderFilterOptions
                      value={f.jobProfileType}
                      allLabel="Placement and internship"
                      options={(['PLACEMENT', 'INTERNSHIP'] as const).map((t) => ({ value: t, label: JOB_PROFILE_TYPE_LABELS[t] }))}
                      onChange={(v) => set({ jobProfileType: v as CandidateFilters['jobProfileType'] })}
                    />
                    <p className="px-2 pt-2 text-xs font-medium text-muted-foreground">Job profile</p>
                    <TableHeaderFilterOptions value={f.jobRoleId} options={(roles.data ?? []).map((r) => ({ value: r.id, label: jobProfileLabel(r) }))} onChange={(v) => set({ jobRoleId: v })} />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Round
                  <TableHeaderFilter active={Boolean(f.roundId)} ariaLabel="Filter by round" className="w-72">
                    <TableHeaderFilterOptions value={f.roundId} options={roundOptions(roles.data ?? []).map((o) => ({ value: o.id, label: o.label }))} onChange={(v) => set({ roundId: v })} />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  College
                  <TableHeaderFilter active={Boolean(f.collegeId || f.driveId)} ariaLabel="Filter by college or drive" className="w-80">
                    <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">College</p>
                    <TableHeaderFilterOptions
                      value={f.collegeId}
                      options={(colleges.data ?? []).map((c) => ({ value: c.id, label: `${c.shortCode} · ${c.name}` }))}
                      onChange={(v) => set({ collegeId: v })}
                    />
                    <p className="px-2 pt-2 text-xs font-medium text-muted-foreground">Drive</p>
                    <TableHeaderFilterOptions
                      value={f.driveId}
                      options={allDrives(roles.data ?? []).map((d) => ({ value: d.id, label: d.displayName }))}
                      onChange={(v) => set({ driveId: v })}
                    />
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
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Result
                  <TableHeaderFilter active={Boolean(f.result)} ariaLabel="Filter by result">
                    <TableHeaderFilterOptions
                      value={f.result}
                      options={[
                        { value: 'SHORTLISTED', label: 'Shortlisted' },
                        { value: 'REJECTED', label: 'Rejected' },
                        { value: 'NONE', label: 'No decision' },
                      ]}
                      onChange={(v) => set({ result: v as CandidateFilters['result'] })}
                    />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              <SortHead label="Time taken" field="timeTaken" f={f} onSort={onSort} />
              <TableHead>Attempted</TableHead>
              <SortHead label="Marks" field="marks" f={f} onSort={onSort} min={{ key: 'marksPctMin', label: 'Min %', hint: 'Marks as % of max, 0–100', onChange: setMin }} />
              <SortHead label="X %" field="xPercentage" f={f} onSort={onSort} min={{ key: 'xMin', label: 'Min X %', hint: '0–100', onChange: setMin }} />
              <SortHead label="XII %" field="xiiPercentage" f={f} onSort={onSort} min={{ key: 'xiiMin', label: 'Min XII %', hint: '0–100', onChange: setMin }} />
              <SortHead label="CPI" field="majorCpi" f={f} onSort={onSort} min={{ key: 'cpiMin', label: 'Min CPI', hint: '0–10', onChange: setMin }} />
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
              <TableHead title="Other candidates who started the exam within 100 m and 2 hours">Nearby</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending && <TableRow><TableCell colSpan={16} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {data?.items.length === 0 && <TableRow><TableCell colSpan={16} className="text-muted-foreground">No candidates match.</TableCell></TableRow>}
            {data?.items.map((c) => (
              <TableRow key={c.id} data-state={selected.has(c.id) ? 'selected' : undefined}>
                <TableCell>
                  <input type="checkbox" className="h-4 w-4 accent-primary" aria-label={`Select ${c.fullName}`} checked={selected.has(c.id)} onChange={() => toggle(c)} />
                </TableCell>
                <TableCell className="font-mono text-xs">{c.candidateCode}</TableCell>
                <TableCell>
                  <Link to={`/admin/candidates/${c.id}`} className="font-medium text-primary hover:underline">{c.fullName}</Link>
                  <div className="text-xs text-muted-foreground">{c.email}</div>
                  {c.otherApplications.length > 0 && <div className="text-xs text-muted-foreground">Also in: {otherAppsText(c)}</div>}
                </TableCell>
                <TableCell>
                  {c.jobRoleName}
                  {c.jobProfileType === 'INTERNSHIP' && <Badge variant="secondary" className="ml-1">Internship</Badge>}
                </TableCell>
                <TableCell className="whitespace-nowrap">Round {c.roundNumber}</TableCell>
                <TableCell className="whitespace-nowrap" title={c.driveDisplayName}>
                  {c.collegeShortCode}
                  <div className="text-xs text-muted-foreground">{batchOf(c.driveDisplayName, c.collegeShortCode)}</div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{statusText(c.status)}</Badge>
                  {!c.eligible && <Badge variant="outline" className="ml-1">Not eligible</Badge>}
                </TableCell>
                <TableCell><ResultBadge result={c.result} /></TableCell>
                <TableCell className="whitespace-nowrap">{c.exam ? timeTaken(c.exam.startedAt, c.exam.submittedAt) : '-'}</TableCell>
                <TableCell className="whitespace-nowrap">{c.exam ? `${c.exam.answeredCount} / ${c.exam.questionCount}` : '-'}</TableCell>
                <TableCell className="whitespace-nowrap">{marksText(c.exam)}</TableCell>
                <TableCell>{c.xPercentage ?? '-'}</TableCell>
                <TableCell>{c.xiiPercentage ?? '-'}</TableCell>
                <TableCell>{c.majorCpi ?? '-'}</TableCell>
                <TableCell>{c.flagCount > 0 ? <Badge variant="default">{c.flagCount}</Badge> : '-'}</TableCell>
                <TableCell>{c.nearbyCount ?? '-'}</TableCell>
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
      <MoveToDriveDialog open={moving} candidateIds={[...selected]} onClose={() => setMoving(false)} onDone={clearSelection} />
      <SendEmailDialog open={emailing} candidateIds={[...selected]} onClose={() => setEmailing(false)} onDone={clearSelection} />
      <DecisionDialog
        open={deciding !== null}
        decision={deciding ?? 'SHORTLISTED'}
        candidateIds={[...selected]}
        driveCount={driveCount}
        onClose={() => setDeciding(null)}
        onDone={clearSelection}
      />
      <AddCandidateDialog
        open={adding}
        defaultDriveId={f.driveId || undefined}
        onClose={() => setAdding(false)}
      />
      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Import candidates</DialogTitle>
            <DialogDescription>Rows with an existing or repeated email or mobile are flagged and skipped.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            <ImportWizard
              kind="CANDIDATES"
              targets={allDrives(roles.data ?? []).filter((d) => d.active).map((d) => ({ id: d.id, name: d.displayName }))}
              defaultTargetId={f.driveId || undefined}
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
