// src/pages/admin/EmailTemplates.tsx
// Why: Super Admins edit the subject/body of the two candidate emails here, preview them
// (sandboxed iframe, debounced) and send a test to themselves. The API adds the branded
// layout; unknown {placeholders} are flagged inline because the API rejects them on save.

import { useRef, useState } from 'react';
import type { EmailTemplateDto, EmailTemplateKey } from '@exam/shared';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useEmailPreview, useEmailTemplates, useResetEmailTemplate, useSaveEmailTemplate, useSendTestEmail } from '@/api/admin/emails';
import { EmailDispatchTable } from '@/components/admin/EmailDispatchTable';
import { EmailErrorNote } from '@/components/admin/EmailErrorNote';
import { EmailPreviewFrame } from '@/components/admin/EmailPreviewFrame';
import { NextRoundFields } from '@/components/admin/NextRoundFields';
import { EMPTY_NEXT_ROUND, insertAtCursor, nextRoundLinkError, nextRoundPayload, placeholderText, unknownPlaceholders } from '@/lib/emailTemplates';
import { formatIst } from '@/lib/istTime';
import { useDebounced } from '@/lib/useDebounced';

function TemplateEditor({ t }: { t: EmailTemplateDto }) {
  const save = useSaveEmailTemplate(t.key);
  const reset = useResetEmailTemplate(t.key);
  const test = useSendTestEmail(t.key);
  const [subject, setSubject] = useState(t.subject);
  const [body, setBody] = useState(t.body);
  const [round, setRound] = useState(EMPTY_NEXT_ROUND);
  const [confirmReset, setConfirmReset] = useState(false);
  const [lastField, setLastField] = useState<'subject' | 'body'>('body');
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const allowed = t.placeholders.map((p) => p.token);
  const unknown = unknownPlaceholders(`${subject}\n${body}`, allowed);
  const dirty = subject !== t.subject || body !== t.body;
  const nextRound = t.key === 'SHORTLISTED' ? nextRoundPayload(round) : undefined;
  const linkBad = t.key === 'SHORTLISTED' && nextRoundLinkError(round.link) !== null;
  const previewInput = useDebounced({ subject, body, nextRound }, 400);
  const preview = useEmailPreview(t.key, previewInput, !linkBad);

  const insert = (token: string) => {
    const el = lastField === 'subject' ? subjectRef.current : bodyRef.current;
    const value = lastField === 'subject' ? subject : body;
    const r = insertAtCursor(value, el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length, placeholderText(token));
    (lastField === 'subject' ? setSubject : setBody)(r.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(r.cursor, r.cursor);
    });
  };

  const payload = { subject, body, nextRound };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t.description}</p>
        <div className="space-y-1.5">
          <Label htmlFor={`et-subject-${t.key}`}>Subject</Label>
          <Input id={`et-subject-${t.key}`} ref={subjectRef} maxLength={200} value={subject} onFocus={() => setLastField('subject')} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`et-body-${t.key}`}>Body</Label>
          <Textarea id={`et-body-${t.key}`} ref={bodyRef} rows={12} maxLength={5000} value={body} onFocus={() => setLastField('body')} onChange={(e) => setBody(e.target.value)} />
          <p className="text-xs text-muted-foreground">Plain text. A blank line starts a new paragraph. The layout, details table and link button are added automatically.</p>
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Placeholders <span className="font-normal text-muted-foreground">(click to insert into the {lastField})</span></p>
          <div className="flex flex-wrap gap-1.5">
            {t.placeholders.map((p) => (
              <Button key={p.token} type="button" size="sm" variant="outline" title={p.description} onClick={() => insert(p.token)}>
                {placeholderText(p.token)}
              </Button>
            ))}
          </div>
        </div>
        {unknown.length > 0 && (
          <p role="alert" className="text-sm text-destructive">Unknown placeholder{unknown.length === 1 ? '' : 's'}: {unknown.join(', ')}. Saving will be rejected.</p>
        )}
        {t.key === 'SHORTLISTED' && (
          <div className="space-y-1">
            <NextRoundFields idPrefix={`et-${t.key}`} value={round} onChange={setRound} />
            <p className="text-xs text-muted-foreground">Sample values for the preview only. They are entered when sending.</p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={!dirty || unknown.length > 0 || save.isPending || !subject.trim() || !body.trim()} onClick={() => save.mutate({ subject, body })}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button type="button" variant="outline" disabled={t.isDefault || reset.isPending} onClick={() => setConfirmReset(true)}>Reset to default</Button>
          <Button type="button" variant="outline" disabled={test.isPending || linkBad} onClick={() => test.mutate(payload)}>
            {test.isPending ? 'Sending…' : 'Send test to me'}
          </Button>
        </div>
        <div aria-live="polite" className="text-sm">
          {save.isSuccess && !dirty && <p className="text-muted-foreground">Saved.</p>}
          {test.isSuccess && <p className="text-muted-foreground">Test sent to {test.data.sentTo}.</p>}
        </div>
        <EmailErrorNote error={save.error ?? test.error ?? reset.error} />
        <p className="text-xs text-muted-foreground">
          {t.isDefault ? 'Using the built-in default.' : `Last saved ${formatIst(t.updatedAt)}${t.updatedByName ? ` by ${t.updatedByName}` : ''}.`}
        </p>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium">Preview</p>
        <EmailPreviewFrame subject={preview.data?.subject} html={preview.data?.html} loading={preview.isFetching} error={preview.error && !preview.data ? preview.error.message : undefined} />
      </div>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset to default?"
        description="Your edits to this template are discarded and the built-in wording is used again."
        confirmLabel="Reset"
        isPending={reset.isPending}
        onConfirm={() => reset.mutate(undefined, { onSuccess: () => setConfirmReset(false) })}
      />
    </div>
  );
}

export default function EmailTemplates() {
  const { data, isPending, error } = useEmailTemplates();
  if (isPending) return <p className="text-sm text-muted-foreground" role="status">Loading…</p>;
  if (error || !data) return <p className="text-sm text-destructive" role="alert">{error?.message ?? 'Could not load templates'}</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-foreground">Email templates</h1>
      <p className="text-sm text-muted-foreground">Emails are sent manually from Candidates, the Leaderboard or a candidate's page. Nothing is sent automatically.</p>
      <Tabs defaultValue={data[0]?.key ?? 'sent'}>
        <TabsList>
          {data.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.name}</TabsTrigger>)}
          <TabsTrigger value="sent">Sent emails</TabsTrigger>
        </TabsList>
        {data.map((t) => (
          <TabsContent key={t.key} value={t.key}>
            {/* keyed by save time so a save/reset reloads the fields from the server copy */}
            <TemplateEditor key={`${t.key as EmailTemplateKey}-${t.updatedAt ?? 'default'}`} t={t} />
          </TabsContent>
        ))}
        <TabsContent value="sent"><EmailDispatchTable filterable /></TabsContent>
      </Tabs>
    </div>
  );
}
