// src/pages/admin/AuditLog.tsx
// Why: Super Admin read-only view of admin_audit_logs. Filters sit in the column
// headers (the CRM pattern); entity is free text, admin is a picker, the date range uses
// date inputs. Rows are append-only so there are no row actions.

import { useState } from 'react';
import { Pagination } from '@/components/ui/pagination';
import { ClearFiltersButton } from '@/components/ui/clear-filters-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TableHeaderFilter, TableHeaderFilterOptions, TableHeaderFilterText } from '@/components/ui/table-header-filter';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAllAdmins } from '@/api/admin/users';
import { useAuditLog, type AuditFilters } from '@/api/admin/audit';

const EMPTY: AuditFilters = { entity: '', adminId: '', from: '', to: '' };
const PAGE_SIZE_FALLBACK = 50;

export default function AuditLog() {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY);
  const [page, setPage] = useState(1);
  const { data, isPending, error } = useAuditLog(filters, page);
  const admins = useAllAdmins();
  const pageSize = data?.pageSize ?? PAGE_SIZE_FALLBACK;
  const set = (patch: Partial<AuditFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const activeCount = Object.values(filters).filter(Boolean).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">Audit log</h1>
        <ClearFiltersButton count={activeCount} onClear={() => set(EMPTY)} />
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  When
                  <TableHeaderFilter active={Boolean(filters.from || filters.to)} ariaLabel="Filter by date range" className="w-56">
                    <div className="space-y-2 p-1.5">
                      <div className="space-y-1">
                        <Label htmlFor="audit-from">From</Label>
                        <Input id="audit-from" type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="audit-to">To</Label>
                        <Input id="audit-to" type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
                      </div>
                    </div>
                  </TableHeaderFilter>
                </span>
              </TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Admin
                  <TableHeaderFilter active={Boolean(filters.adminId)} ariaLabel="Filter by admin">
                    <TableHeaderFilterOptions value={filters.adminId} options={(admins.data ?? []).map((a) => ({ value: a.id, label: a.name }))} onChange={(v) => set({ adminId: v })} />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              <TableHead>Action</TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1.5">
                  Entity
                  <TableHeaderFilter active={Boolean(filters.entity)} ariaLabel="Filter by entity">
                    <TableHeaderFilterText label="Entity" value={filters.entity} onChange={(v) => set({ entity: v })} />
                  </TableHeaderFilter>
                </span>
              </TableHead>
              <TableHead>Details</TableHead>
              <TableHead>IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending && <TableRow><TableCell colSpan={6} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {data?.items.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">No entries.</TableCell></TableRow>}
            {data?.items.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</TableCell>
                <TableCell>{r.adminName ?? r.adminId ?? 'System'}</TableCell>
                <TableCell className="font-mono text-xs">{r.action}</TableCell>
                <TableCell>{r.entity}{r.entityId ? ` · ${r.entityId}` : ''}</TableCell>
                <TableCell className="max-w-xs truncate font-mono text-xs text-muted-foreground" title={r.metadata ? JSON.stringify(r.metadata) : undefined}>
                  {r.metadata ? JSON.stringify(r.metadata) : ''}
                </TableCell>
                <TableCell>{r.ip ?? ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {data && (
        <Pagination page={data.page} pageSize={pageSize} total={data.total} totalPages={Math.max(1, Math.ceil(data.total / pageSize))} onPageChange={setPage} />
      )}
    </div>
  );
}
