// src/pages/admin/Questions.tsx
// Why: Super Admin authors a role's questions (design §5): add/edit, active toggle,
// drag-to-reorder and CSV/XLSX import. Once any candidate has started, the server locks
// the set (423 QUESTIONS_LOCKED); the banner explains it and offers an audited Unlock.

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Lock } from 'lucide-react';
import { ImportWizard } from '@/components/import/ImportWizard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRoles } from '@/api/admin/roles';
import {
  QUESTION_SAMPLE_URL,
  QUESTION_TEMPLATE_URL,
  confirmQuestionImport,
  previewQuestionImport,
  useQuestions,
  useReorderQuestions,
  useSaveQuestion,
  useSetQuestionActive,
  useUnlockQuestions,
  type Question,
} from '@/api/admin/questions';
import { useQueryClient } from '@tanstack/react-query';

const questionSchema = z.object({
  questionText: z.string().trim().min(10, 'At least 10 characters').max(5000, 'At most 5,000 characters'),
  maxMarks: z
    .number({ invalid_type_error: 'Enter marks' })
    .min(0.5, 'At least 0.5')
    .max(100, 'At most 100')
    .refine((n) => Math.round(n * 2) === n * 2, 'Use steps of 0.5'),
  evaluatorGuidance: z.string().max(5000, 'At most 5,000 characters'),
});
type QValues = z.infer<typeof questionSchema>;

function QuestionDialog({ jobRoleId, editing, open, onClose }: { jobRoleId: string; editing: Question | null; open: boolean; onClose: () => void }) {
  const save = useSaveQuestion(jobRoleId);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<QValues>({
    resolver: zodResolver(questionSchema),
    values: { questionText: editing?.questionText ?? '', maxMarks: editing?.maxMarks ?? 10, evaluatorGuidance: editing?.evaluatorGuidance ?? '' },
  });
  const close = () => {
    reset();
    save.reset();
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit question' : 'Add question'}</DialogTitle>
          <DialogDescription>Evaluator guidance is never shown to candidates.</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={handleSubmit((v) =>
            save.mutate(
              { ...(editing ? { id: editing.id } : {}), questionText: v.questionText, maxMarks: v.maxMarks, evaluatorGuidance: v.evaluatorGuidance.trim() || null },
              { onSuccess: close },
            ),
          )}
        >
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-4">
            <div className="space-y-1.5">
              <Label htmlFor="q-text">Question</Label>
              <Textarea id="q-text" rows={6} error={errors.questionText?.message} {...register('questionText')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-marks">Max marks</Label>
              <Input id="q-marks" type="number" step={0.5} min={0.5} max={100} error={errors.maxMarks?.message} {...register('maxMarks', { valueAsNumber: true })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-guid">Evaluator guidance (optional)</Label>
              <Textarea id="q-guid" rows={4} error={errors.evaluatorGuidance?.message} {...register('evaluatorGuidance')} />
            </div>
            {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const reasonSchema = z.object({ reason: z.string().trim().min(10, 'Give a reason (at least 10 characters)') });

function UnlockDialog({ jobRoleId, open, onClose }: { jobRoleId: string; open: boolean; onClose: () => void }) {
  const unlock = useUnlockQuestions(jobRoleId);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<{ reason: string }>({ resolver: zodResolver(reasonSchema), defaultValues: { reason: '' } });
  const close = () => {
    reset();
    unlock.reset();
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlock questions</DialogTitle>
          <DialogDescription>Candidates have already started. Editing changes what later candidates see. This is audited.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3 px-6 pb-2" noValidate onSubmit={handleSubmit((v) => unlock.mutate(v.reason, { onSuccess: close }))}>
          <div className="space-y-1.5">
            <Label htmlFor="ul-reason">Reason</Label>
            <Textarea id="ul-reason" rows={3} error={errors.reason?.message} {...register('reason')} />
          </div>
          {unlock.isError && <p role="alert" className="text-sm text-destructive">{unlock.error.message}</p>}
          <DialogFooter className="-mx-6">
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" variant="destructive" disabled={unlock.isPending}>{unlock.isPending ? 'Unlocking…' : 'Unlock'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SortableRow({ q, index, locked, onEdit, onToggle }: { q: Question; index: number; locked: boolean; onEdit: () => void; onToggle: (a: boolean) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: q.id, disabled: locked });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-start gap-3 rounded-lg border border-border bg-card p-3 ${isDragging ? 'z-10 shadow-md' : ''} ${q.active ? '' : 'opacity-60'}`}
    >
      <button
        type="button"
        className="mt-0.5 cursor-grab touch-none rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={`Reorder question ${index + 1} (space to lift, arrows to move)`}
        disabled={locked}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium"><span className="text-muted-foreground">Q{index + 1}.</span> {q.questionText.length > 220 ? `${q.questionText.slice(0, 220)}…` : q.questionText}</p>
        <p className="text-xs text-muted-foreground">{q.maxMarks} marks{q.evaluatorGuidance ? ' · has guidance' : ''}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch checked={q.active} disabled={locked} onCheckedChange={onToggle} aria-label={`Question ${index + 1} active`} />
        <Button size="sm" variant="outline" disabled={locked} onClick={onEdit}>Edit</Button>
      </div>
    </li>
  );
}

export default function Questions() {
  const roles = useRoles();
  const [jobRoleId, setJobRoleId] = useState('');
  const effectiveRoleId = jobRoleId || roles.data?.[0]?.id || '';
  const role = roles.data?.find((r) => r.id === effectiveRoleId);
  const locked = role?.settings.questionsLocked ?? false;
  const { data, isPending, error } = useQuestions(effectiveRoleId);
  const reorder = useReorderQuestions(effectiveRoleId);
  const setActive = useSetQuestionActive(effectiveRoleId);
  const qc = useQueryClient();

  const [items, setItems] = useState<Question[]>([]);
  useEffect(() => {
    if (data) setItems([...data].sort((a, b) => a.displayOrder - b.displayOrder));
  }, [data]);

  const [dialog, setDialog] = useState<{ editing: Question | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = items.findIndex((q) => q.id === e.active.id);
    const to = items.findIndex((q) => q.id === e.over?.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(items, from, to);
    setItems(next);
    reorder.mutate(next.map((q) => q.id));
  };

  const actionError = reorder.error ?? setActive.error;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">Questions</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!effectiveRoleId || locked} onClick={() => setImporting(true)}>Import CSV/XLSX</Button>
          <Button disabled={!effectiveRoleId || locked} onClick={() => setDialog({ editing: null })}>Add question</Button>
        </div>
      </div>

      <div className="max-w-md space-y-1.5">
        <Label htmlFor="q-role">Job role</Label>
        <Select id="q-role" value={effectiveRoleId} onChange={(e) => setJobRoleId(e.target.value)}>
          {roles.data?.map((r) => (
            <option key={r.id} value={r.id}>{r.name} ({r.counts.questions})</option>
          ))}
        </Select>
      </div>

      {locked && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 p-3 text-sm">
          <span className="flex items-center gap-2"><Lock className="h-4 w-4" /> Questions are locked because candidates have started this exam.</span>
          <Button size="sm" variant="outline" onClick={() => setUnlocking(true)}>Unlock</Button>
        </div>
      )}
      {(error || roles.error || actionError) && (
        <p className="text-sm text-destructive" role="alert">{(error ?? roles.error ?? actionError)?.message}</p>
      )}

      {isPending && effectiveRoleId && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && items.length === 0 && <p className="text-sm text-muted-foreground">No questions for this role yet.</p>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((q) => q.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-2">
            {items.map((q, i) => (
              <SortableRow key={q.id} q={q} index={i} locked={locked} onEdit={() => setDialog({ editing: q })} onToggle={(active) => setActive.mutate({ id: q.id, active })} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {items.length > 0 && <Badge variant="outline">{items.filter((q) => q.active).length} active of {items.length}</Badge>}

      <QuestionDialog jobRoleId={effectiveRoleId} editing={dialog?.editing ?? null} open={dialog !== null} onClose={() => setDialog(null)} />
      <UnlockDialog jobRoleId={effectiveRoleId} open={unlocking} onClose={() => setUnlocking(false)} />
      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Import questions</DialogTitle>
            <DialogDescription>Duplicates (same text in the role) are flagged and skipped.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            <ImportWizard
              kind="QUESTIONS"
              jobRoles={roles.data ?? []}
              defaultJobRoleId={effectiveRoleId}
              templateUrl={QUESTION_TEMPLATE_URL}
              sampleUrl={QUESTION_SAMPLE_URL}
              previewFn={previewQuestionImport}
              confirmFn={confirmQuestionImport}
              onImported={() => void qc.invalidateQueries({ queryKey: ['admin'] })}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
