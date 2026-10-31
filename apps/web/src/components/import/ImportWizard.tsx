// src/components/import/ImportWizard.tsx
// Why: one 4-step import flow for candidates and questions (design §5, §6.1): choose
// role + file -> preview (valid / errors / duplicates) -> confirm -> summary. Step
// logic lives in lib/importState; this is the thin view. A 409 on confirm means the same
// file was imported before, so the button becomes "Import anyway" (re-sent with force).

import { useReducer, useRef, useState } from 'react';
import { Download, FileUp } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  importReducer,
  initialImportState,
  type ImportPreview,
  type ImportResult,
  type ImportState,
} from '@/lib/importState';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Row = Record<string, unknown>;

export interface ImportWizardProps {
  kind: 'CANDIDATES' | 'QUESTIONS';
  jobRoles: Array<{ id: string; name: string }>;
  templateUrl: string;
  /** Optional filled-in example file, offered next to the header-only template. */
  sampleUrl?: string;
  previewFn: (file: File, jobRoleId: string, opts?: { updateExisting?: boolean }) => Promise<ImportPreview<Row>>;
  confirmFn: (a: { previewId: string; force?: boolean }) => Promise<ImportResult>;
  /** Called after a successful import so the host page can refresh. */
  onImported?: () => void;
  defaultJobRoleId?: string;
}

const COLUMNS: Record<ImportWizardProps['kind'], Array<{ key: string; label: string }>> = {
  CANDIDATES: [
    { key: 'fullName', label: 'Name' },
    { key: 'email', label: 'Email' },
    { key: 'rollNumber', label: 'Roll no.' },
    { key: 'mobile', label: 'Mobile' },
  ],
  QUESTIONS: [
    { key: 'questionText', label: 'Question' },
    { key: 'maxMarks', label: 'Max marks' },
    { key: 'displayOrder', label: 'Order' },
  ],
};

const DUP_TEXT = { IN_FILE: 'Repeated in this file', EXISTS: 'Already exists' } as const;
const ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function ImportWizard({ kind, jobRoles, templateUrl, sampleUrl, previewFn, confirmFn, onImported, defaultJobRoleId }: ImportWizardProps) {
  const [state, dispatch] = useReducer(
    (s: ImportState<Row>, a: Parameters<typeof importReducer<Row>>[1]) => importReducer<Row>(s, a),
    initialImportState as ImportState<Row>,
  );
  const [jobRoleId, setJobRoleId] = useState(defaultJobRoleId ?? '');
  const [file, setFile] = useState<File | null>(null);
  // Candidates only: existing (not yet started) candidates in the file are moved to the
  // chosen job profile and their details refreshed, instead of being skipped.
  const [updateExisting, setUpdateExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const noun = kind === 'CANDIDATES' ? 'candidates' : 'questions';

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const preview = () =>
    run(async () => {
      if (!file || !jobRoleId) return;
      dispatch({ type: 'PREVIEW_OK', preview: await previewFn(file, jobRoleId, kind === 'CANDIDATES' ? { updateExisting } : undefined) });
    });

  const confirm = (force: boolean) =>
    run(async () => {
      const p = state.preview;
      if (!p) return;
      try {
        const result = await confirmFn(force ? { previewId: p.previewId, force: true } : { previewId: p.previewId });
        dispatch({ type: 'CONFIRM_OK', result });
        onImported?.();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.code === 'CONFLICT') {
          dispatch({ type: 'CONFIRM_CONFLICT', message: e.message });
          return;
        }
        throw e;
      }
    });

  const restart = () => {
    dispatch({ type: 'RESET' });
    setFile(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const p = state.preview;
  const updates = p?.updates?.length ?? 0;
  // Confirm is possible when there is anything to create or update.
  const actionable = (p?.summary.valid ?? 0) + updates;
  const cols = COLUMNS[kind];

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Import steps">
        {(['choose', 'preview', 'done'] as const).map((s, i) => (
          <li key={s}>
            <Badge variant={state.step === s ? 'default' : 'outline'} aria-current={state.step === s ? 'step' : undefined}>
              {i + 1}. {s === 'choose' ? 'Choose file' : s === 'preview' ? 'Preview and confirm' : 'Summary'}
            </Badge>
          </li>
        ))}
      </ol>

      {state.step === 'choose' && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="imp-role">{kind === 'CANDIDATES' ? 'Job role for this file' : 'Job role'}</Label>
            <Select id="imp-role" value={jobRoleId} onChange={(e) => setJobRoleId(e.target.value)}>
              <option value="">Select a role…</option>
              {jobRoles.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </Select>
            {kind === 'CANDIDATES' && (
              <p className="text-xs text-muted-foreground">A job_role column in the file overrides this per row.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="imp-file">CSV or XLSX file (max 5 MB)</Label>
            <input
              id="imp-file"
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm"
            />
          </div>
          {kind === 'CANDIDATES' && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-primary"
                checked={updateExisting}
                onChange={(e) => setUpdateExisting(e.target.checked)}
              />
              <span>
                Update existing candidates
                <span className="block text-xs text-muted-foreground">
                  Candidates already in the system are moved to this job profile and their details updated from the file
                  (empty cells keep the current value). Candidates who have started an exam are not changed.
                </span>
              </span>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={preview} disabled={busy || !file || !jobRoleId}>
              <FileUp className="mr-1.5 h-4 w-4" />
              {busy ? 'Reading…' : 'Preview'}
            </Button>
            <a href={templateUrl} download className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
              <Download className="h-4 w-4" /> Download template
            </a>
            {sampleUrl && (
              <a href={sampleUrl} download className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
                <Download className="h-4 w-4" /> Download sample
              </a>
            )}
          </div>
        </div>
      )}

      {state.step === 'preview' && p && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2" aria-label="Preview summary">
            <Badge variant="outline">{p.summary.total} rows</Badge>
            <Badge variant="default">{p.summary.valid} valid</Badge>
            <Badge variant="outline">{p.summary.errors} errors</Badge>
            <Badge variant="outline">{p.summary.duplicates} duplicates</Badge>
            {p.updates && <Badge variant="default">{p.updates.length} to update</Badge>}
          </div>
          <Tabs defaultValue="valid">
            <TabsList>
              <TabsTrigger value="valid">Valid ({p.valid.length})</TabsTrigger>
              <TabsTrigger value="errors">Errors ({p.errors.length})</TabsTrigger>
              <TabsTrigger value="duplicates">Duplicates ({p.duplicates.length})</TabsTrigger>
              {p.updates && <TabsTrigger value="updates">Updates ({p.updates.length})</TabsTrigger>}
            </TabsList>
            <TabsContent value="valid">
              <div className="max-h-72 overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>{cols.map((c) => <TableHead key={c.key}>{c.label}</TableHead>)}</TableRow>
                  </TableHeader>
                  <TableBody>
                    {p.valid.length === 0 && (
                      <TableRow><TableCell colSpan={cols.length} className="text-muted-foreground">No valid rows.</TableCell></TableRow>
                    )}
                    {p.valid.map((r, i) => (
                      <TableRow key={i}>
                        {cols.map((c) => (
                          <TableCell key={c.key} className="max-w-xs truncate">{String(r[c.key] ?? '')}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
            <TabsContent value="errors">
              <div className="max-h-72 overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Row</TableHead><TableHead>Field</TableHead><TableHead>Message</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {p.errors.length === 0 && (
                      <TableRow><TableCell colSpan={3} className="text-muted-foreground">No errors.</TableCell></TableRow>
                    )}
                    {p.errors.map((e, i) => (
                      <TableRow key={i}><TableCell>{e.row}</TableCell><TableCell>{e.field}</TableCell><TableCell>{e.message}</TableCell></TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
            <TabsContent value="duplicates">
              <div className="max-h-72 overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Row</TableHead><TableHead>Reason</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {p.duplicates.length === 0 && (
                      <TableRow><TableCell colSpan={2} className="text-muted-foreground">No duplicates.</TableCell></TableRow>
                    )}
                    {p.duplicates.map((d, i) => (
                      <TableRow key={i}><TableCell>{d.row}</TableCell><TableCell>{DUP_TEXT[d.reason]}</TableCell></TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
            {p.updates && (
              <TabsContent value="updates">
                <div className="max-h-72 overflow-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>{cols.map((c) => <TableHead key={c.key}>{c.label}</TableHead>)}</TableRow>
                    </TableHeader>
                    <TableBody>
                      {p.updates.length === 0 && (
                        <TableRow><TableCell colSpan={cols.length} className="text-muted-foreground">No existing candidates to update.</TableCell></TableRow>
                      )}
                      {p.updates.map((r, i) => (
                        <TableRow key={i}>
                          {cols.map((c) => (
                            <TableCell key={c.key} className="max-w-xs truncate">{String(r[c.key] ?? '')}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
            )}
          </Tabs>
          {state.canForce && (
            <p role="alert" className="rounded-md border border-border bg-muted/50 p-3 text-sm">
              {state.conflictMessage ?? 'This file was already imported.'} You can import it anyway.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => dispatch({ type: 'BACK' })} disabled={busy}>Back</Button>
            {state.canForce ? (
              <Button type="button" onClick={() => confirm(true)} disabled={busy || actionable === 0}>
                {busy ? 'Importing…' : 'Import anyway'}
              </Button>
            ) : (
              <Button type="button" onClick={() => confirm(false)} disabled={busy || actionable === 0}>
                {busy ? 'Importing…' : updates > 0 ? `Import ${p.summary.valid}, update ${updates}` : `Import ${p.summary.valid} ${noun}`}
              </Button>
            )}
          </div>
        </div>
      )}

      {state.step === 'done' && state.result && (
        <div className="space-y-3" role="status">
          <p className="text-sm">
            Imported <strong>{state.result.imported}</strong> {noun};{' '}
            {state.result.updated !== undefined && <>updated <strong>{state.result.updated}</strong> existing;{' '}</>}
            skipped <strong>{state.result.skipped}</strong> (errors or duplicates).
          </p>
          <Button type="button" variant="outline" onClick={restart}>Import another file</Button>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
