// src/components/admin/EmailPreviewFrame.tsx
// Why: the rendered email is HTML from the server; it is shown only in a script-less,
// origin-less sandboxed iframe, never injected into the app's DOM.

export function EmailPreviewFrame({ subject, html, loading, error }: { subject?: string; html?: string; loading?: boolean; error?: string }) {
  return (
    <div className="space-y-2" aria-busy={loading}>
      <p className="text-sm"><span className="text-muted-foreground">Subject: </span>{subject ?? '…'}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <iframe title="Email preview" sandbox="" srcDoc={html ?? ''} className="h-[28rem] w-full rounded-md border border-border bg-white" />
    </div>
  );
}
