// src/components/admin/AiPanel.tsx
// Why: shows the AI's suggestion for one question on the marking screen (docs/ai-evaluation.md
// §8). It is advice only: "Use AI mark" just fills the draft field, and saving/submitting stays
// in the existing flow. Blind-safe: the score DTO carries no candidate data.

import type { AiQuestionScoreDto } from '@exam/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CONCERN_LABEL, CONFIDENCE_LABEL, usableAiMarks } from '@/lib/aiEvaluation';

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-semibold text-muted-foreground">{title}</div>
      <ul className="list-disc pl-5 text-sm">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}

export function AiPanel({ ai, readOnly, onUse }: { ai: AiQuestionScoreDto | null; readOnly: boolean; onUse: () => void }) {
  if (!ai) return null;
  const marks = usableAiMarks(ai);
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3" aria-label="AI suggestion">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">AI suggestion</div>
        {marks !== null && (
          <Button type="button" size="sm" variant="outline" disabled={readOnly} onClick={onUse}>Use AI mark</Button>
        )}
      </div>
      {ai.status === 'QUEUED' && <p className="text-sm text-muted-foreground" role="status">Queued: the AI has not graded this answer yet.</p>}
      {ai.status === 'FAILED' && <p className="text-sm text-destructive" role="status">The AI could not grade this answer{ai.error ? `: ${ai.error}` : '.'}</p>}
      {ai.status === 'DONE' && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{ai.marks} / {ai.maxMarks}</span>
            {ai.confidence && <Badge variant={ai.confidence === 'LOW' ? 'destructive' : 'outline'}>{CONFIDENCE_LABEL[ai.confidence]}</Badge>}
            {ai.concerns.map((c) => <Badge key={c} variant="destructive">{CONCERN_LABEL[c]}</Badge>)}
          </div>
          {ai.rationale && <p className="whitespace-pre-wrap text-sm">{ai.rationale}</p>}
          <List title="Strengths" items={ai.strengths} />
          <List title="Improvements" items={ai.improvements} />
        </>
      )}
    </div>
  );
}
