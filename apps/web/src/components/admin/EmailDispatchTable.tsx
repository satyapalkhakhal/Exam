// src/components/admin/EmailDispatchTable.tsx
// Why: the sent-emails log is shown on the templates page (all candidates, filterable) and
// on a candidate's detail page (one candidate); one table keeps both consistent.

import { useState } from 'react';
import { Link } from 'react-router';
import { EMAIL_DISPATCH_STATUSES, type EmailDispatchStatus, type EmailTemplateKey } from '@exam/shared';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import { TableHeaderFilter, TableHeaderFilterOptions } from '@/components/ui/table-header-filter';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useEmailDispatches } from '@/api/admin/emails';
import { formatIst } from '@/lib/istTime';

export const TEMPLATE_NAMES: Record<EmailTemplateKey, string> = {
  SUBMISSION_RECEIVED: 'Submission received',
  SHORTLISTED: 'Shortlisted',
  REJECTED: 'Not selected',
};
const STATUS_TEXT: Record<EmailDispatchStatus, string> = { QUEUED: 'Queued', SENT: 'Sent', FAILED: 'Failed' };

export function EmailDispatchTable({ candidateId, filterable = false }: { candidateId?: string; filterable?: boolean }) {
  const [page, setPage] = useState(1);
  const [template, setTemplate] = useState('');
  const [status, setStatus] = useState('');
  const { data, error, isPending } = useEmailDispatches({
    candidateId,
    page,
    pageSize: 25,
    template: (template || undefined) as EmailTemplateKey | undefined,
    status: (status || undefined) as EmailDispatchStatus | undefined,
  });
  const reset = (fn: () => void) => { fn(); setPage(1); };
  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When (IST)</TableHead>
              {!candidateId && <TableHead>Candidate</TableHead>}
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Template
                  {filterable && (
                    <TableHeaderFilter active={Boolean(template)} ariaLabel="Filter by template">
                      <TableHeaderFilterOptions value={template} options={Object.entries(TEMPLATE_NAMES).map(([value, label]) => ({ value, label }))} onChange={(v) => reset(() => setTemplate(v))} />
                    </TableHeaderFilter>
                  )}
                </span>
              </TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Status
                  {filterable && (
                    <TableHeaderFilter active={Boolean(status)} ariaLabel="Filter by status">
                      <TableHeaderFilterOptions value={status} options={EMAIL_DISPATCH_STATUSES.map((s) => ({ value: s, label: STATUS_TEXT[s] }))} onChange={(v) => reset(() => setStatus(v))} />
                    </TableHeaderFilter>
                  )}
                </span>
              </TableHead>
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending && <TableRow><TableCell colSpan={6} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {data?.items.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">No emails yet.</TableCell></TableRow>}
            {data?.items.map((d) => (
              <TableRow key={d.id}>
                <TableCell>{formatIst(d.sentAt ?? d.createdAt)}</TableCell>
                {!candidateId && (
                  <TableCell>
                    <Link to={`/admin/candidates/${d.candidateId}`} className="text-primary hover:underline">{d.fullName}</Link>
                    <div className="font-mono text-xs text-muted-foreground">{d.candidateCode}</div>
                  </TableCell>
                )}
                <TableCell>{TEMPLATE_NAMES[d.template]}</TableCell>
                <TableCell>{d.subject}</TableCell>
                <TableCell>
                  <Badge variant={d.status === 'FAILED' ? 'destructive' : d.status === 'SENT' ? 'default' : 'outline'}>{STATUS_TEXT[d.status]}</Badge>
                  {d.status === 'FAILED' && d.error && <div className="mt-1 text-xs text-destructive">{d.error}</div>}
                </TableCell>
                <TableCell>{d.sentByName ?? '-'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {data && data.total > data.pageSize && (
        <Pagination page={data.page} pageSize={data.pageSize} total={data.total} totalPages={Math.max(1, Math.ceil(data.total / data.pageSize))} onPageChange={setPage} />
      )}
    </div>
  );
}
