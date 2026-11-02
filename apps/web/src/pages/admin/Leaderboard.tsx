// src/pages/admin/Leaderboard.tsx
// Why: Super Admin's per-role ranking (design §8): one tab per job role, shortlist/reject
// with an optional comment, and the two XLSX exports as plain GET links (the browser
// downloads them with the session cookie).

import { useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SendEmailDialog } from '@/components/admin/SendEmailDialog';
import { ReasonDialog } from '@/components/admin/ReasonDialog';
import { TableHeaderFilter, TableHeaderFilterText } from '@/components/ui/table-header-filter';
import { matchesCandidateSearch } from '@/lib/candidateSearch';
import { useRoles } from '@/api/admin/roles';
import { activityExportUrl, resultsExportUrl, useDecision, useLeaderboard, type Decision, type LeaderboardRow } from '@/api/admin/results';
import { statusText } from '@/pages/admin/Candidates';
import { totalFlags, flagTitle } from '@/pages/admin/Submissions';

export default function Leaderboard() {
  const roles = useRoles();
  const [picked, setPicked] = useState('');
  const jobRoleId = picked || roles.data?.[0]?.id || '';
  const board = useLeaderboard(jobRoleId);
  const decide = useDecision();
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
                    <TableHeaderFilterText label="Search" value={search} onChange={setSearch} hint="Name, email, roll number or code" />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              {questionCols.map((c) => <TableHead key={c.order}>Q{c.order}</TableHead>)}
              <TableHead>Total</TableHead>
              <TableHead>%</TableHead>
              <TableHead>Flags</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Decision</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {board.isPending && jobRoleId && <TableRow><TableCell colSpan={7 + questionCols.length} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {board.data?.length === 0 && <TableRow><TableCell colSpan={7 + questionCols.length} className="text-muted-foreground">No evaluated candidates yet.</TableCell></TableRow>}
            {board.data && board.data.length > 0 && rows.length === 0 && (
              <TableRow><TableCell colSpan={7 + questionCols.length} className="text-muted-foreground">No candidate matches the search.</TableCell></TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.candidateId}>
                <TableCell className="font-semibold">{r.rank}</TableCell>
                <TableCell>
                  <Link to={`/admin/candidates/${r.candidateId}`} className="font-medium text-primary hover:underline">{r.fullName}</Link>
                  <div className="font-mono text-xs text-muted-foreground">{r.candidateCode}</div>
                </TableCell>
                {r.questionMarks.map((m) => <TableCell key={m.order}>{m.marks ?? '-'}</TableCell>)}
                <TableCell>{r.totalMarks} / {r.maxMarks}</TableCell>
                <TableCell>{r.percentage}</TableCell>
                <TableCell title={flagTitle(r.flagCounts)}>{totalFlags(r.flagCounts) > 0 ? <Badge variant="default">{totalFlags(r.flagCounts)}</Badge> : '-'}</TableCell>
                <TableCell><Badge variant="outline">{statusText(r.status)}</Badge></TableCell>
                <TableCell>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" disabled={r.status === 'SHORTLISTED'} onClick={() => setTarget({ row: r, decision: 'SHORTLISTED' })}>Shortlist</Button>
                    <Button size="sm" variant="outline" disabled={r.status === 'REJECTED'} onClick={() => setTarget({ row: r, decision: 'REJECTED' })}>Reject</Button>
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
        defaultTemplate={emailRow?.status === 'SHORTLISTED' ? 'SHORTLISTED' : 'SUBMISSION_RECEIVED'}
        onClose={() => setEmailRow(null)}
      />
      <ReasonDialog
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) {
            setTarget(null);
            decide.reset();
          }
        }}
        title={target?.decision === 'SHORTLISTED' ? `Shortlist ${target.row.fullName}` : `Reject ${target?.row.fullName ?? ''}`}
        description="The decision is recorded in the candidate's status history."
        label="Comment (optional)"
        required={false}
        confirmLabel={target?.decision === 'SHORTLISTED' ? 'Shortlist' : 'Reject'}
        isPending={decide.isPending}
        error={decide.error?.message}
        onSubmit={(comment) =>
          target && decide.mutate({ candidateId: target.row.candidateId, decision: target.decision, comment: comment || undefined }, { onSuccess: () => setTarget(null) })
        }
      />
    </div>
  );
}
