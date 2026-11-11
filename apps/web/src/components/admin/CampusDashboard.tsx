// src/components/admin/CampusDashboard.tsx
// Why: the Super Admin's campus hiring dashboard (spec 2026-11-11), laid out after the user's
// reference mock-up on live data: filters, KPI cards, applications by institution, the
// evaluation funnel, institution- / profile- / internship-wise reports and the ranking. Every
// number comes from lib/campusDashboard (pure, tested); this file only renders. Evaluators never
// reach it (blind marking): Dashboard.tsx shows them the per-round cards.

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { DashboardDriveDto, JobProfileType } from '@exam/shared';
import { Download, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DEFAULT_DASH_FILTERS,
  applyFilters,
  avgExamPct,
  byInstitution,
  candidatesLink,
  filterOptions,
  institutionProfileMatrix,
  institutionStatusRows,
  internshipRows,
  profileRows,
  rankingGroups,
  selectionPct,
  showOneInstitutionNote,
  submissionsLink,
  toCsv,
  totals,
  type DashFilters,
  type PerformanceTag,
} from '@/lib/campusDashboard';
import { cn } from '@/lib/utils';

const PROGRAMME_LABEL: Record<JobProfileType, string> = { PLACEMENT: 'Placement', INTERNSHIP: 'Internship' };
const ONE_INSTITUTION = 'Comparisons across institutions appear once candidates from more colleges take the exam.';
const pct = (n: number | null) => (n === null ? '—' : `${n}%`);

function ProgrammeTag({ p }: { p: JobProfileType }) {
  return (
    <Badge variant="outline" className={cn(p === 'INTERNSHIP' ? 'border-teal-300 text-teal-700 dark:border-teal-700 dark:text-teal-300' : 'border-primary/40 text-primary')}>
      {PROGRAMME_LABEL[p]}
    </Badge>
  );
}

function PerformanceBadge({ tag }: { tag: PerformanceTag | null }) {
  if (!tag) return <span className="text-muted-foreground">—</span>;
  const tone =
    tag === 'Strong'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
      : tag === 'Good'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
        : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';
  return <span className={cn('inline-block rounded-full px-2 py-0.5 text-xs font-semibold', tone)}>{tag}</span>;
}

function Kpi({ label, value, foot, tone }: { label: string; value: number; foot: string; tone: string }) {
  return (
    <Card className="min-w-0">
      <CardContent className="space-y-1 p-4">
        <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground">
          {label}
          <span className={cn('h-2.5 w-2.5 rounded-full', tone)} aria-hidden="true" />
        </div>
        <div className="text-2xl font-bold tabular-nums text-foreground">{value}</div>
        <div className="text-xs text-muted-foreground">{foot}</div>
      </CardContent>
    </Card>
  );
}

function Section({ title, sub, children, aside }: { title: string; sub: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
        </div>
        {aside}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Empty({ cols }: { cols: number }) {
  return (
    <TableRow>
      <TableCell colSpan={cols} className="text-muted-foreground">No drives match these filters.</TableCell>
    </TableRow>
  );
}

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const STATUS_HEADERS = ['Applied', 'Not started', 'In progress', 'Submitted', 'Pending eval.', 'Evaluated', 'Selected', 'Rejected'] as const;
type StatusRow = { applications: number; notStarted: number; inProgress: number; submitted: number; pending: number; evaluated: number; selected: number; rejected: number };
const statusCells = (r: StatusRow) => [r.applications, r.notStarted, r.inProgress, r.submitted, r.pending, r.evaluated, r.selected, r.rejected];

export function CampusDashboard({ drives }: { drives: DashboardDriveDto[] }) {
  const [f, setF] = useState<DashFilters>(DEFAULT_DASH_FILTERS);
  const [tab, setTab] = useState<'applications' | 'status'>('applications');
  const [rankSearch, setRankSearch] = useState('');
  const set = (patch: Partial<DashFilters>) => setF((c) => ({ ...c, ...patch }));

  const options = useMemo(() => filterOptions(drives), [drives]);
  const rows = useMemo(() => applyFilters(drives, f), [drives, f]);
  const t = totals(rows);
  const bars = byInstitution(rows);
  const maxBar = Math.max(1, ...bars.map((b) => b.applications));
  const matrix = institutionProfileMatrix(rows);
  const statusRows = institutionStatusRows(rows);
  const profiles = profileRows(rows);
  const interns = internshipRows(rows);
  const needle = rankSearch.trim().toLowerCase();
  const ranking = rankingGroups(rows)
    .map((g) => ({ ...g, items: g.items.filter((i) => !needle || `${i.name} ${g.profile}`.toLowerCase().includes(needle)) }))
    .filter((g) => g.items.length > 0);
  const single = showOneInstitutionNote(f, rows);

  const funnel: [string, number, string][] = [
    ['Not started', t.notStarted, 'border-l-primary'],
    ['In progress', t.inProgress, 'border-l-violet-500'],
    ['Submitted', t.submitted, 'border-l-teal-500'],
    ['Pending evaluation', t.pending, 'border-l-amber-500'],
    ['Evaluated', t.evaluated, 'border-l-emerald-500'],
  ];

  const exportCsv = () => {
    const date = new Date().toISOString().slice(0, 10);
    const csv =
      tab === 'applications'
        ? toCsv(['Institution', 'Programme', ...matrix.profiles, 'Total applications'], matrix.rows.map((r) => [r.name, PROGRAMME_LABEL[r.programme], ...r.perProfile, r.total]))
        : toCsv(['Institution', 'Programme', ...STATUS_HEADERS], statusRows.map((r) => [r.name, PROGRAMME_LABEL[r.programme], ...statusCells(r)]));
    download(`institution-report-${date}.csv`, csv);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-primary">Recruitment intelligence</div>
          <h1 className="text-xl font-semibold text-foreground">Campus hiring dashboard</h1>
          <p className="text-sm text-muted-foreground">Institution and profile performance across Internship and Placement.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setF(DEFAULT_DASH_FILTERS)}>Reset filters</Button>
          <Button variant="outline" asChild><Link to={candidatesLink(f)}>View candidates</Link></Button>
          <Button variant="outline" asChild><Link to={submissionsLink(f)}>View submissions</Link></Button>
          <Button onClick={exportCsv} disabled={rows.length === 0}><Download className="mr-1.5 h-4 w-4" aria-hidden="true" />Export CSV</Button>
        </div>
      </div>

      <section aria-label="Dashboard filters" className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-3 xl:grid-cols-5">
        <div className="space-y-1.5">
          <Label htmlFor="dash-batch">Batch</Label>
          <Select id="dash-batch" value={f.batch} onChange={(e) => set({ batch: e.target.value })}>
            <option value="">All batches</option>
            {options.batches.map((b) => <option key={b} value={b}>{b}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dash-college">Institution</Label>
          <Select id="dash-college" value={f.collegeId} onChange={(e) => set({ collegeId: e.target.value })}>
            <option value="">All institutions</option>
            {options.colleges.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dash-profile">Job profile</Label>
          <Select id="dash-profile" value={f.jobRoleId} onChange={(e) => set({ jobRoleId: e.target.value })}>
            <option value="">All profiles</option>
            {options.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dash-programme">Programme</Label>
          <Select id="dash-programme" value={f.programme} onChange={(e) => set({ programme: e.target.value as DashFilters['programme'] })}>
            <option value="">Internship &amp; Placement</option>
            <option value="INTERNSHIP">Internship</option>
            <option value="PLACEMENT">Placement</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dash-round">Round</Label>
          <Select id="dash-round" value={f.roundNumber} onChange={(e) => set({ roundNumber: e.target.value })}>
            <option value="">All rounds</option>
            {options.rounds.map((n) => <option key={n} value={String(n)}>Round {n}</option>)}
          </Select>
        </div>
      </section>
      {f.roundNumber === '' && <p className="text-xs text-muted-foreground">All rounds: a candidate moved to a later round is counted once per round.</p>}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-label="Key figures">
        <Kpi label="Applications" value={t.applications} foot="Across institutions and profiles" tone="bg-primary" />
        <Kpi label="Submitted" value={t.submitted} foot="Exam submission completed" tone="bg-teal-500" />
        <Kpi label="Pending evaluation" value={t.pending} foot="Awaiting evaluator action" tone="bg-amber-500" />
        <Kpi label="Selected" value={t.selected} foot="Shortlisted" tone="bg-emerald-500" />
        <Kpi label="Rejected" value={t.rejected} foot="Decision recorded" tone="bg-red-500" />
      </section>

      {single && <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">{ONE_INSTITUTION}</p>}

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Section title="Applications by institution" sub="Candidate volume across participating colleges">
          {bars.length === 0 ? (
            <p className="text-sm text-muted-foreground">No drives match these filters.</p>
          ) : (
            <ul className="space-y-3">
              {bars.map((b) => (
                <li key={b.collegeId} className="grid grid-cols-[minmax(6rem,10rem)_1fr_3rem] items-center gap-3 text-sm">
                  <span className="truncate" title={b.name}>{b.name}</span>
                  <span className="h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span className="block h-full rounded-full bg-primary" style={{ width: `${(b.applications / maxBar) * 100}%` }} />
                  </span>
                  <strong className="text-right tabular-nums">{b.applications}</strong>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Candidate evaluation funnel" sub="Current pipeline status">
          <ul className="space-y-2">
            {funnel.map(([label, n, tone]) => (
              <li key={label} className={cn('flex items-center justify-between rounded-md border-l-4 bg-muted/50 px-3 py-2 text-sm', tone)}>
                <span>{label}</span>
                <strong className="tabular-nums">{n}</strong>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Workflow status is tracked separately from the final decision. Avg. exam % {pct(avgExamPct(t))} · Selection {pct(selectionPct(t))} of decided.
          </p>
        </Section>
      </div>

      <Section title="Institution-wise report" sub="College × programme × profile">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="applications">Applications by profile</TabsTrigger>
            <TabsTrigger value="status">Candidate status</TabsTrigger>
          </TabsList>
          <TabsContent value="applications" className="mt-3 overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Institution</TableHead>
                  <TableHead>Programme</TableHead>
                  {matrix.profiles.map((p) => <TableHead key={p}>{p}</TableHead>)}
                  <TableHead>Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matrix.rows.length === 0 && <Empty cols={3 + matrix.profiles.length} />}
                {matrix.rows.map((r) => (
                  <TableRow key={`${r.name}-${r.programme}`}>
                    <TableCell className="font-semibold">{r.name}</TableCell>
                    <TableCell><ProgrammeTag p={r.programme} /></TableCell>
                    {r.perProfile.map((n, i) => <TableCell key={i} className="tabular-nums">{n}</TableCell>)}
                    <TableCell className="font-semibold tabular-nums">{r.total}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>
          <TabsContent value="status" className="mt-3 overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Institution</TableHead>
                  <TableHead>Programme</TableHead>
                  {STATUS_HEADERS.map((h) => <TableHead key={h}>{h}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {statusRows.length === 0 && <Empty cols={2 + STATUS_HEADERS.length} />}
                {statusRows.map((r) => (
                  <TableRow key={`${r.name}-${r.programme}`}>
                    <TableCell className="font-semibold">{r.name}</TableCell>
                    <TableCell><ProgrammeTag p={r.programme} /></TableCell>
                    {statusCells(r).map((n, i) => <TableCell key={i} className="tabular-nums">{n}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>
        </Tabs>
        <p className="mt-2 text-xs text-muted-foreground">Export CSV saves the tab on screen.</p>
      </Section>

      <Section title="Profile-wise report" sub="Performance by role and institution">
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                {['Job profile', 'Institution', 'Programme', 'Applied', 'Avg. exam %', 'Selected', 'Rejected', 'Selection %'].map((h) => <TableHead key={h}>{h}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.length === 0 && <Empty cols={8} />}
              {profiles.map((r) => (
                <TableRow key={`${r.profile}-${r.institution}-${r.programme}`}>
                  <TableCell className="font-semibold">{r.profile}</TableCell>
                  <TableCell>{r.institution}</TableCell>
                  <TableCell><ProgrammeTag p={r.programme} /></TableCell>
                  <TableCell className="tabular-nums">{r.applications}</TableCell>
                  <TableCell className="font-semibold tabular-nums">{pct(r.avgExamPct)}</TableCell>
                  <TableCell className="tabular-nums">{r.selected}</TableCell>
                  <TableCell className="tabular-nums">{r.rejected}</TableCell>
                  <TableCell className="tabular-nums">{pct(r.selectionPct)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      {f.programme !== 'PLACEMENT' && (
        <Section title="Internship report" sub="Internship pipeline by institution and profile" aside={<ProgrammeTag p="INTERNSHIP" />}>
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Institution</TableHead>
                  <TableHead>Job profile</TableHead>
                  {STATUS_HEADERS.map((h) => <TableHead key={h}>{h}</TableHead>)}
                  <TableHead>Selection %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {interns.length === 0 && (
                  <TableRow><TableCell colSpan={3 + STATUS_HEADERS.length} className="text-muted-foreground">No internship drives match these filters.</TableCell></TableRow>
                )}
                {interns.map((r) => (
                  <TableRow key={`${r.institution}-${r.profile}`}>
                    <TableCell className="font-semibold">{r.institution}</TableCell>
                    <TableCell>{r.profile}</TableCell>
                    {statusCells(r).map((n, i) => <TableCell key={i} className="tabular-nums">{n}</TableCell>)}
                    <TableCell className="tabular-nums">{pct(r.selectionPct)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}

      <Section
        title="Institution & profile ranking"
        sub="Ranked within the same job profile, programme and round by average exam %, then selection %"
        aside={
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input aria-label="Search institution or profile" placeholder="Search institution or profile…" className="w-60 pl-8" value={rankSearch} onChange={(e) => setRankSearch(e.target.value)} />
          </div>
        }
      >
        {ranking.length === 0 ? (
          <p className="text-sm text-muted-foreground">{rows.length === 0 ? 'No drives match these filters.' : 'Nothing matches the search.'}</p>
        ) : (
          <div className="space-y-4">
            {ranking.map((g) => (
              <div key={`${g.profile}-${g.programme}-${g.roundNumber}`} className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  {g.profile} <ProgrammeTag p={g.programme} />
                  {f.roundNumber === '' && <span className="text-xs font-normal text-muted-foreground">Round {g.roundNumber}</span>}
                </h3>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {['Rank', 'Institution', 'Applied', 'Avg. exam %', 'Selection %', 'Selected', 'Performance'].map((h) => <TableHead key={h}>{h}</TableHead>)}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {g.items.map((i) => (
                        <TableRow key={i.name}>
                          <TableCell className="font-bold text-primary">#{i.rank}</TableCell>
                          <TableCell className="font-semibold">{i.name}</TableCell>
                          <TableCell className="tabular-nums">{i.applications}</TableCell>
                          <TableCell className="font-semibold tabular-nums">{pct(i.avgExamPct)}</TableCell>
                          <TableCell className="tabular-nums">{pct(i.selectionPct)}</TableCell>
                          <TableCell className="tabular-nums">{i.selected}</TableCell>
                          <TableCell><PerformanceBadge tag={i.tag} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Strong: avg ≥ 84% · Good: ≥ 78% · Needs review: below 78%. Different role families and different rounds are never ranked against each other.</p>
      </Section>
    </div>
  );
}
