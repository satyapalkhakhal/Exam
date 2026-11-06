// src/pages/admin/Leaderboard.tsx
// Why: Super Admin's per-role ranking (design §8): one tab per job role, shortlist/reject
// through the shared decision dialog (which also sends the email), and the two XLSX
// exports as plain GET links (the browser downloads them with the session cookie).

import { useState } from 'react';
import { Link } from 'react-router';
import { LEADERBOARD_SORTS, type LeaderboardSort } from '@exam/shared';
import { isProvisional } from '@/lib/aiEvaluation';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SendEmailDialog } from '@/components/admin/SendEmailDialog';
import { DecisionDialog } from '@/components/admin/DecisionDialog';
import { ResultBadge } from '@/components/admin/ResultBadge';
import { TableHeaderFilter, TableHeaderFilterText } from '@/components/ui/table-header-filter';
import { matchesCandidateSearch } from '@/lib/candidateSearch';
import { useRoles } from '@/api/admin/roles';
import { activityExportUrl, resultsExportUrl, useLeaderboard, type Decision, type LeaderboardRow } from '@/api/admin/results';
import { templateForResult } from '@/lib/emailTemplates';
import { totalFlags, flagTitle } from '@/pages/admin/Submissions';

const SORT_LABEL: Record<LeaderboardSort, string> = { human: 'Human total', composite: 'Composite', ai: 'AI %' };
const pct = (n: number | null) => (n === null ? '-' : String(n));

export default function Leaderboard() {
  const roles = useRoles();
  const [picked, setPicked] = useState('');
  const jobRoleId = picked || roles.data?.[0]?.id || '';
  const [sort, setSort] = useState<LeaderboardSort>('human');
  const board = useLeaderboard(jobRoleId, sort);
  const [target, setTarget] = useState<{ row: LeaderboardRow; decision: Decision } | null>(null);
  const [emailRow, setEmailRow] = useState<LeaderboardRow | null>(null);
  const [search, setSearch] = useState('');
  // Filters the loaded board; ranks stay the real ranks.
  const rows = (board.data ?? []).filter((r) => matchesCandidateSearch(r, search));
  const questionCols = board.data?.[0]?.questionMarks ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">Leaderboard</h1>
        {jobRoleId && (
          <div className="flex gap-2">
            <Button asChild variant="outline"><a href={resultsExportUrl(jobRoleId)}>Export results XLSX</a></Button>
            <Button asChild variant="outline"><a href={activityExportUrl(jobRoleId)}>Export activity XLSX</a></Button>
          </div>
        )}
      </div>
      <Tabs value={jobRoleId} onValueChange={setPicked}>
        <TabsList aria-label="Job role">
          {(roles.data ?? []).map((r) => <TabsTrigger key={r.id} value={r.id}>{r.name}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <div className="flex items-center gap-2">
        <Label htmlFor="lb-sort">Sort by</Label>
        <select
          id="lb-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as LeaderboardSort)}
          className="h-9 rounded-lg border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {LEADERBOARD_SORTS.map((o) => <option key={o} value={o}>{SORT_LABEL[o]}</option>)}
        </select>
      </div>
      {board.error && <p className="text-sm text-destructive" role="alert">{board.error.message}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rank</TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Candidate
                  <TableHeaderFilter active={Boolean(search)} ariaLabel="Search by name, email, roll number or code" className="w-56">
                    <TableHeaderFilterText label="Search" value={search} onChange={setSearch} hint="Name, roll number or code (emails are masked here)" />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              {questionCols.map((c) => <TableHead key={c.order}>Q{c.order}</TableHead>)}
              <TableHead>Total</TableHead>
              <TableHead>%</TableHead>
              <TableHead>AI %</TableHead>
              <TableHead>Composite</TableHead>
              <TableHead>Flags</TableHead>
              <TableHead title="Other candidates who started the exam within 100 m and 2 hours">Nearby</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Decision</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {board.isPending && jobRoleId && <TableRow><TableCell colSpan={10 + questionCols.length} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {board.data?.length === 0 && <TableRow><TableCell colSpan={10 + questionCols.length} className="text-muted-foreground">No evaluated candidates yet.</TableCell></TableRow>}
            {board.data && board.data.length > 0 && rows.length === 0 && (
              <TableRow><TableCell colSpan={10 + questionCols.length} className="text-muted-foreground">No candidate matches the search.</TableCell></TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.candidateId}>
                <TableCell className="font-semibold">{r.rank}</TableCell>
                <TableCell>
                  <Link to={`/admin/candidates/${r.candidateId}`} className="font-medium text-primary hover:underline">{r.fullName}</Link>
                  <div className="font-mono text-xs text-muted-foreground">{r.candidateCode}</div>
                </TableCell>
                {r.questionMarks.map((m) => (
                  <TableCell key={m.order}>
                    {m.marks ?? '-'}
                    {m.aiMarks !== null && <div className="text-xs text-muted-foreground" title="AI suggested marks">AI {m.aiMarks}</div>}
                  </TableCell>
                ))}
                <TableCell>{r.totalMarks} / {r.maxMarks}</TableCell>
                <TableCell>{r.percentage}</TableCell>
                <TableCell>{pct(r.aiPercentage)}</TableCell>
                <TableCell>
                  {pct(r.compositeScore)}
                  {isProvisional(r) && (
                    <Badge variant="outline" className="ml-1" title="Based on the AI exam % because no human evaluation is submitted yet">provisional</Badge>
                  )}
                </TableCell>
                <TableCell title={flagTitle(r.flagCounts)}>{totalFlags(r.flagCounts) > 0 ? <Badge variant="default">{totalFlags(r.flagCounts)}</Badge> : '-'}</TableCell>
                <TableCell>{r.nearbyCount ?? '-'}</TableCell>
                <TableCell><ResultBadge result={r.result} /></TableCell>
                <TableCell>
                  <div className="flex gap-1.5">
                    {/* AI-only rows (composite/AI sort) have no submitted human evaluation yet: the server refuses a decision on them. */}
                    {r.status === 'EVALUATED' ? (
                      <>
                        <Button size="sm" variant="outline" disabled={r.result === 'SHORTLISTED'} onClick={() => setTarget({ row: r, decision: 'SHORTLISTED' })}>Shortlist</Button>
                        <Button size="sm" variant="outline" disabled={r.result === 'REJECTED'} onClick={() => setTarget({ row: r, decision: 'REJECTED' })}>Reject</Button>
                      </>
                    ) : (
                      <span className="self-center text-xs text-muted-foreground" title="Confirm the marks in Submissions before deciding">Awaiting marking</span>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setEmailRow(r)}>Email</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <SendEmailDialog
        open={emailRow !== null}
        candidateIds={emailRow ? [emailRow.candidateId] : []}
        defaultTemplate={templateForResult(emailRow?.result ?? null)}
        onClose={() => setEmailRow(null)}
      />
      <DecisionDialog
        open={target !== null}
        decision={target?.decision ?? 'SHORTLISTED'}
        candidateIds={target ? [target.row.candidateId] : []}
        onClose={() => setTarget(null)}
      />
    </div>
  );
}
