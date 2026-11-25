// src/components/admin/SendEmailDialog.tsx
// Why: one dialog for every "send email" entry point (bulk on Candidates, per row on the
// Leaderboard, Candidate detail). The server decides who is skipped and says why; the
// preview uses sample data for the chosen template. The Round 2 assignment needs a file:
// it is uploaded as soon as it is picked and its id goes with the send.

import { useMemo, useState } from 'react';
import { ATTACHMENT_TEMPLATES, EMAIL_ATTACHMENT_TYPES, type EmailAttachmentDto, type EmailTemplateKey } from '@exam/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useEmailPreview, useSendEmails, useUploadEmailAttachment } from '@/api/admin/emails';
import { EmailErrorNote } from '@/components/admin/EmailErrorNote';
import { EmailPreviewFrame } from '@/components/admin/EmailPreviewFrame';
import { NextRoundFields } from '@/components/admin/NextRoundFields';
import { EMPTY_NEXT_ROUND, attachmentFileError, formatFileSize, nextRoundLinkError, nextRoundPayload, skipReasonLabel } from '@/lib/emailTemplates';
import { useDebounced } from '@/lib/useDebounced';

const TEMPLATE_LABEL: Record<EmailTemplateKey, string> = {
  SUBMISSION_RECEIVED: 'Submission received',
  SHORTLISTED: 'Shortlisted for next round',
  REJECTED: 'Not selected',
  ASSIGNMENT: 'Round 2 assignment',
};
const ACCEPT = Object.keys(EMAIL_ATTACHMENT_TYPES).join(',');

export function SendEmailDialog({
  open,
  candidateIds,
  defaultTemplate = 'SUBMISSION_RECEIVED',
  onClose,
  onDone,
}: {
  open: boolean;
  candidateIds: string[];
  defaultTemplate?: EmailTemplateKey;
  onClose: () => void;
  /** Called after a successful queue so the page can clear its selection. */
  onDone?: () => void;
}) {
  const send = useSendEmails();
  const [template, setTemplate] = useState<EmailTemplateKey>(defaultTemplate);
  const [round, setRound] = useState(EMPTY_NEXT_ROUND);
  const [resend, setResend] = useState(false);
  const upload = useUploadEmailAttachment();
  const [attachment, setAttachment] = useState<EmailAttachmentDto | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const needsFile = ATTACHMENT_TEMPLATES.includes(template);
  const nextRound = useMemo(() => (template === 'SHORTLISTED' ? nextRoundPayload(round) : undefined), [template, round]);
  const linkBad = template === 'SHORTLISTED' && nextRoundLinkError(round.link) !== null;
  const debounced = useDebounced({ nextRound, attachmentName: needsFile ? attachment?.fileName : undefined }, 400);
  const preview = useEmailPreview(template, debounced, open && !linkBad);
  const result = send.data;
  const n = candidateIds.length;

  const close = () => {
    send.reset();
    setRound(EMPTY_NEXT_ROUND);
    setResend(false);
    setTemplate(defaultTemplate);
    setAttachment(null);
    setFileError(null);
    upload.reset();
    onClose();
  };

  const pickFile = (file: File | undefined) => {
    setAttachment(null);
    upload.reset();
    if (!file) return setFileError(null);
    const err = attachmentFileError(file);
    setFileError(err);
    if (!err) upload.mutate(file, { onSuccess: setAttachment });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Send email</DialogTitle>
          <DialogDescription>
            {result ? 'The emails are queued and go out shortly.' : `To ${n} selected candidate${n === 1 ? '' : 's'}. Candidates who do not qualify are skipped.`}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
          {result ? (
            <div className="space-y-3" aria-live="polite">
              <p className="text-sm"><strong>{result.queued}</strong> queued, <strong>{result.skipped.length}</strong> skipped.</p>
              {result.skipped.length > 0 && (
                <ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-sm">
                  {result.skipped.map((s) => (
                    <li key={s.candidateId} className="flex justify-between gap-3">
                      <span>{s.fullName ?? 'Unknown'} <span className="font-mono text-xs text-muted-foreground">{s.candidateCode ?? ''}</span></span>
                      <span className="text-muted-foreground">{skipReasonLabel(s.reason)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="se-template">Template</Label>
                <Select id="se-template" value={template} onChange={(e) => setTemplate(e.target.value as EmailTemplateKey)}>
                  {(Object.keys(TEMPLATE_LABEL) as EmailTemplateKey[]).map((k) => <option key={k} value={k}>{TEMPLATE_LABEL[k]}</option>)}
                </Select>
              </div>
              {template === 'SHORTLISTED' && <NextRoundFields idPrefix="se" value={round} onChange={setRound} />}
              {needsFile && (
                <div className="space-y-1.5">
                  <Label htmlFor="se-file">Assignment file</Label>
                  <input
                    id="se-file"
                    type="file"
                    accept={ACCEPT}
                    disabled={upload.isPending}
                    className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-sm"
                    onChange={(e) => pickFile(e.target.files?.[0])}
                  />
                  <p className="text-xs text-muted-foreground">
                    PDF, Word, Excel, PowerPoint or ZIP, up to 5 MB. Every selected candidate receives this file, so send one role at a time.
                  </p>
                  <div aria-live="polite" className="text-sm">
                    {upload.isPending && <p className="text-muted-foreground">Uploading…</p>}
                    {attachment && <p className="text-muted-foreground">Attached: <strong className="text-foreground">{attachment.fileName}</strong> ({formatFileSize(attachment.size)})</p>}
                    {(fileError ?? upload.error?.message) && <p role="alert" className="text-destructive">{fileError ?? upload.error?.message}</p>}
                  </div>
                </div>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={resend} onChange={(e) => setResend(e.target.checked)} />
                Send again to candidates who already received it
              </label>
              <div>
                <p className="mb-1 text-sm font-medium">Preview (sample data)</p>
                <EmailPreviewFrame subject={preview.data?.subject} html={preview.data?.html} loading={preview.isFetching} error={preview.error && !preview.data ? preview.error.message : undefined} />
              </div>
              <EmailErrorNote error={send.error} />
            </>
          )}
          <DialogFooter>
            {result ? (
              <Button type="button" onClick={close}>Done</Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={close}>Cancel</Button>
                <Button
                  type="button"
                  disabled={n === 0 || linkBad || send.isPending || (needsFile && !attachment)}
                  onClick={() =>
                    send.mutate(
                      { template, candidateIds, nextRound, resend: resend || undefined, attachmentId: needsFile ? attachment?.id : undefined },
                      { onSuccess: () => onDone?.() },
                    )
                  }
                >
                  {send.isPending ? 'Queuing…' : `Send to ${n}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
