// src/pages/admin/Leaderboard.tsx
// Why: Super Admin's per-role ranking (design §8): one tab per job role, shortlist/reject
// through the shared decision dialog (which also sends the email), and the two XLSX
// exports as plain GET links (the browser downloads them with the session cookie).

import { useState } from 'react';
import { Link } from 'react-router';
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

export default function Leaderboard() {
  const roles = useRoles();
  const [picked, setPicked] = useState('');
  const jobRoleId = picked || roles.data?.[0]?.id || '';
  const board = useLeaderboard(jobRoleId);
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
                    <TableHeaderFilterText label="Search" value={search} onChange={setSearch} hint="Name, roll number or code (emails are masked here)" />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              {questionCols.map((c) => <TableHead key={c.order}>Q{c.order}</TableHead>)}
              <TableHead>Total</TableHead>
              <TableHead>%</TableHead>
              <TableHead>Flags</TableHead>
              <TableHead title="Other candidates who started the exam within 100 m and 2 hours">Nearby</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Decision</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {board.isPending && jobRoleId && <TableRow><TableCell colSpan={8 + questionCols.length} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {board.data?.length === 0 && <TableRow><TableCell colSpan={8 + questionCols.length} className="text-muted-foreground">No evaluated candidates yet.</TableCell></TableRow>}
            {board.data && board.data.length > 0 && rows.length === 0 && (
              <TableRow><TableCell colSpan={8 + questionCols.length} className="text-muted-foreground">No candidate matches the search.</TableCell></TableRow>
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
                <TableCell>{r.nearbyCount ?? '-'}</TableCell>
                <TableCell><ResultBadge result={r.result} /></TableCell>
                <TableCell>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" disabled={r.result === 'SHORTLISTED'} onClick={() => setTarget({ row: r, decision: 'SHORTLISTED' })}>Shortlist</Button>
                    <Button size="sm" variant="outline" disabled={r.result === 'REJECTED'} onClick={() => setTarget({ row: r, decision: 'REJECTED' })}>Reject</Button>
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
