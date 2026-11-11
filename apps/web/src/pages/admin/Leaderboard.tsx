// src/pages/admin/Leaderboard.tsx
// Why: Super Admin's per-drive ranking (design §8; spec 2026-11-10: one round of a job
// profile at one college and batch, so colleges, rounds and internships never mix):
// shortlist/reject through the shared decision dialog (which also sends the email),
// "Move shortlisted to Round n+1", and the two XLSX exports of the drive as plain GET
// links (the browser downloads them with the session cookie).

import { useState } from 'react';
import { Link } from 'react-router';
import { LEADERBOARD_SORTS, type LeaderboardSort } from '@exam/shared';
import { isProvisional } from '@/lib/aiEvaluation';
import { mcqCell } from '@/lib/marking';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DrivePicker } from '@/components/admin/DrivePicker';
import { PromoteDialog } from '@/components/admin/PromoteDialog';
import { locateDrive } from '@/lib/drivePicker';
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
  const [driveId, setDriveId] = useState<string | null>(null);
  const [sort, setSort] = useState<LeaderboardSort>('human');
  const board = useLeaderboard(driveId ?? '', sort);
  const [promoting, setPromoting] = useState(false);
  const located = driveId ? locateDrive(roles.data ?? [], driveId) : null;
  const drive = located?.drive ?? null;
  const hasNextRound = Boolean(
    drive && roles.data?.find((r) => r.id === located?.jobRoleId)?.rounds.some((r) => r.roundNumber === drive.roundNumber + 1),
  );
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
        {driveId && (
          <div className="flex flex-wrap gap-2">
            {hasNextRound && drive && (
              <Button onClick={() => setPromoting(true)}>Move shortlisted to Round {drive.roundNumber + 1}</Button>
            )}
            <Button asChild variant="outline"><a href={resultsExportUrl(driveId)}>Export results XLSX</a></Button>
            <Button asChild variant="outline"><a href={activityExportUrl(driveId)}>Export activity XLSX</a></Button>
          </div>
        )}
      </div>
      <div className="max-w-3xl">
        <DrivePicker value={driveId} onChange={setDriveId} includeInactive idPrefix="lb" inline />
      </div>
      {!driveId && <p className="text-sm text-muted-foreground">Pick a drive: each college's drive of a round has its own ranking.</p>}
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
              <TableHead title="Multiple-choice marks (auto-marked at submit)">MCQ</TableHead>
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
            {board.isPending && driveId && <TableRow><TableCell colSpan={11 + questionCols.length} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {board.data?.length === 0 && <TableRow><TableCell colSpan={11 + questionCols.length} className="text-muted-foreground">No evaluated candidates yet.</TableCell></TableRow>}
            {board.data && board.data.length > 0 && rows.length === 0 && (
              <TableRow><TableCell colSpan={11 + questionCols.length} className="text-muted-foreground">No candidate matches the search.</TableCell></TableRow>
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
                <TableCell className="whitespace-nowrap">{mcqCell(r)}</TableCell>
                <TableCell>{r.totalMarks} / {r.maxMarks}</TableCell>
                <TableCell>{r.percentage}</TableCell>
                <TableCell>{pct(r.aiPercentage)}</TableCell>
                <TableCell>
                  {pct(r.compositeScore)}
                  {isProvisional(r) && (
                    <Badge variant="outline" className="ml-1" title="Based on the AI marks (plus any MCQ marks) because no human evaluation is submitted yet">provisional</Badge>
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
      <PromoteDialog drive={promoting ? drive : null} onClose={() => setPromoting(false)} />
    </div>
  );
}
