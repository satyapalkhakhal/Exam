// src/pages/admin/Questions.tsx
// Why: Super Admin authors a round's questions (design §5; spec 2026-11-10: the bank
// belongs to a round and every college's drive of it uses it): add/edit, active toggle,
// drag-to-reorder and CSV/XLSX import. Once any candidate has started, the server locks
// the set (423 QUESTIONS_LOCKED); the banner explains it and offers an audited Unlock.
// A question is Written (marked by an evaluator) or Multiple choice: 4 options A–D,
// one correct, auto-marked (spec 2026-11-10 MCQ questions). The type is fixed once created.

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
import { CopyQuestionsDialog } from '@/components/admin/CopyQuestionsDialog';
import { roundOptions } from '@/lib/drivePicker';
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
import { MCQ_LETTERS } from '@exam/shared';
import { QUESTION_TYPE_LABELS, optionsSummary, questionFormSchema, toQuestionPayload, type QuestionFormValues } from '@/lib/mcqForm';

const EMPTY_OPTIONS = ['', '', '', ''];

function QuestionDialog({ roundId, editing, open, onClose }: { roundId: string; editing: Question | null; open: boolean; onClose: () => void }) {
  const save = useSaveQuestion(roundId);
  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm<QuestionFormValues>({
    resolver: zodResolver(questionFormSchema),
    values: {
      type: editing?.type ?? 'WRITTEN',
      questionText: editing?.questionText ?? '',
      maxMarks: editing?.maxMarks ?? 10,
      evaluatorGuidance: editing?.evaluatorGuidance ?? '',
      options: editing?.type === 'MCQ' ? [...editing.options] : [...EMPTY_OPTIONS],
      correctOption: editing?.correctOption ?? null,
    },
  });
  const type = watch('type');
  const correct = watch('correctOption');
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
          <DialogDescription>
            {type === 'MCQ'
              ? 'Candidates see the options in a shuffled order. The correct answer is never shown to candidates.'
              : 'Evaluator guidance is never shown to candidates.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={handleSubmit((v) =>
            save.mutate({ ...(editing ? { id: editing.id } : {}), ...toQuestionPayload(v, editing !== null) }, { onSuccess: close }),
          )}
        >
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-4">
            <div className="space-y-1.5">
              <Label htmlFor="q-type">Type</Label>
              <Select id="q-type" disabled={editing !== null} {...register('type')}>
                <option value="WRITTEN">{QUESTION_TYPE_LABELS.WRITTEN}</option>
                <option value="MCQ">{QUESTION_TYPE_LABELS.MCQ}</option>
              </Select>
              {editing && <p className="text-xs text-muted-foreground">The type can't be changed. Add a new question instead.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-text">Question</Label>
              <Textarea id="q-text" rows={6} error={errors.questionText?.message} {...register('questionText')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-marks">Max marks</Label>
              <Input id="q-marks" type="number" step={0.5} min={0.5} max={100} error={errors.maxMarks?.message} {...register('maxMarks', { valueAsNumber: true })} />
            </div>
            {type === 'MCQ' && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Options</legend>
                <p className="text-xs text-muted-foreground">Fill in all four and mark the correct answer.</p>
                {MCQ_LETTERS.map((letter, i) => (
                  <div key={letter} className="flex items-start gap-2">
                    <span className="mt-2 w-5 shrink-0 text-sm font-medium text-muted-foreground">{letter}</span>
                    <div className="min-w-0 flex-1">
                      <Input id={`q-opt-${i}`} aria-label={`Option ${letter}`} error={errors.options?.[i]?.message} {...register(`options.${i}` as const)} />
                    </div>
                    <label className="mt-2 flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                      <input
                        type="radio"
                        name="q-correct"
                        className="h-4 w-4 accent-primary"
                        checked={correct === i}
                        onChange={() => setValue('correctOption', i, { shouldValidate: true })}
                        aria-label={`${letter} is the correct answer`}
                      />
                      Correct
                    </label>
                  </div>
                ))}
                {errors.correctOption?.message && <p role="alert" className="text-sm text-destructive">{errors.correctOption.message}</p>}
              </fieldset>
            )}
            {type !== 'MCQ' && (
              <div className="space-y-1.5">
                <Label htmlFor="q-guid">Evaluator guidance (optional)</Label>
                <Textarea id="q-guid" rows={4} error={errors.evaluatorGuidance?.message} {...register('evaluatorGuidance')} />
              </div>
            )}
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

function UnlockDialog({ roundId, open, onClose }: { roundId: string; open: boolean; onClose: () => void }) {
  const unlock = useUnlockQuestions(roundId);
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
        {q.type === 'MCQ' && <p className="text-xs text-foreground/80">{optionsSummary(q.options, q.correctOption)}</p>}
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={q.type === 'MCQ' ? 'secondary' : 'outline'}>{QUESTION_TYPE_LABELS[q.type]}</Badge>
          {q.maxMarks} marks{q.evaluatorGuidance ? ' · has guidance' : ''}
        </p>
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
  const options = roundOptions(roles.data ?? []);
  const [roundId, setRoundId] = useState('');
  const effectiveRoundId = roundId || options[0]?.id || '';
  const option = options.find((o) => o.id === effectiveRoundId);
  const round = roles.data?.flatMap((r) => r.rounds).find((r) => r.id === effectiveRoundId);
  const locked = round?.questionsLocked ?? false;
  const { data, isPending, error } = useQuestions(effectiveRoundId);
  const reorder = useReorderQuestions(effectiveRoundId);
  const setActive = useSetQuestionActive(effectiveRoundId);
  const [copying, setCopying] = useState(false);
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
          <Button variant="outline" disabled={!effectiveRoundId || locked} onClick={() => setCopying(true)}>Copy from another round…</Button>
          <Button variant="outline" disabled={!effectiveRoundId || locked} onClick={() => setImporting(true)}>Import CSV/XLSX</Button>
          <Button disabled={!effectiveRoundId || locked} onClick={() => setDialog({ editing: null })}>Add question</Button>
        </div>
      </div>

      <div className="max-w-md space-y-1.5">
        <Label htmlFor="q-role">Job profile and round</Label>
        <Select id="q-role" value={effectiveRoundId} onChange={(e) => setRoundId(e.target.value)}>
          {options.map((o) => {
            const count = roles.data?.flatMap((r) => r.rounds).find((r) => r.id === o.id)?.counts.questions ?? 0;
            return <option key={o.id} value={o.id}>{o.label} ({count})</option>;
          })}
        </Select>
        <p className="text-xs text-muted-foreground">Every college's drive of this round uses these questions.</p>
      </div>

      {locked && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 p-3 text-sm">
          <span className="flex items-center gap-2"><Lock className="h-4 w-4" /> Questions are locked because candidates have started this round (in at least one drive).</span>
          <Button size="sm" variant="outline" onClick={() => setUnlocking(true)}>Unlock</Button>
        </div>
      )}
      {(error || roles.error || actionError) && (
        <p className="text-sm text-destructive" role="alert">{(error ?? roles.error ?? actionError)?.message}</p>
      )}

      {isPending && effectiveRoundId && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && items.length === 0 && <p className="text-sm text-muted-foreground">No questions for this round yet.</p>}
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

      <QuestionDialog roundId={effectiveRoundId} editing={dialog?.editing ?? null} open={dialog !== null} onClose={() => setDialog(null)} />
      <UnlockDialog roundId={effectiveRoundId} open={unlocking} onClose={() => setUnlocking(false)} />
      <CopyQuestionsDialog target={copying && option ? { roundId: option.id, label: option.label } : null} onClose={() => setCopying(false)} />
      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Import questions</DialogTitle>
            <DialogDescription>Duplicates (same text in the round) are flagged and skipped.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            <ImportWizard
              kind="QUESTIONS"
              targets={options.map((o) => ({ id: o.id, name: o.label }))}
              defaultTargetId={effectiveRoundId}
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
