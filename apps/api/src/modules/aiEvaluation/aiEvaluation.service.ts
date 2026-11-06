// modules/aiEvaluation/aiEvaluation.service.ts
// AI-assisted grading runs (docs/ai-evaluation.md §2, §4, §5). A run is one
// batch of per-question scores; each score is one queue job. Starting needs AI
// enabled with a key and model (else 409 AI_NOT_CONFIGURED); a whole-role run
// also needs the exam to be over (no attempt in progress and the role closed or
// past its window, else 409 EXAM_NOT_OVER). Only SUBMITTED / AUTO_SUBMITTED
// attempts are ever graded. The processor is the queue job body: it asks the
// injected grader for one question, validates and clamps the marks, and writes
// the score and the run counters together. A malformed reply throws so the job
// retries; the last attempt stores FAILED with a safe reason. The AI never
// writes human marks: a person accepts them through the marking flow.

import {
  AiGradeOutputSchema,
  AI_CONCERNS,
  type AiConcern,
  type AiRunDto,
  type AiRunStartInput,
  type AiRunStartResultDto,
  type AiRunStatus,
} from '@exam/shared';
import { AppError, conflict, notFound } from '../../shared/errors.js';
import { AiOutputError, AiProviderError, safeErrorText } from './aiEvaluation.errors.js';
import { hasAiCredentials, isAiReady, type AiConfig } from './aiEvaluation.config.js';
import { normaliseMarks, type AiGrader } from './aiEvaluation.grader.js';
import { PROMPT_VERSION, buildPrompt } from './aiEvaluation.prompt.js';

export interface RunRow {
  id: string;
  jobRole: { id: string; name: string } | null;
  model: string;
  promptVersion: string;
  status: AiRunStatus;
  total: number;
  done: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  createdBy: { name: string } | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface GradableQuestion {
  attemptQuestionId: string;
  maxMarks: number;
  /** Already has a DONE score. */
  hasDone: boolean;
  /** Has a QUEUED score in a RUNNING run. */
  hasQueued: boolean;
}

export interface ScoreForGrading {
  id: string;
  status: 'QUEUED' | 'DONE' | 'FAILED';
  runStatus: AiRunStatus;
  maxMarks: number;
  questionText: string;
  guidance: string | null;
  answerText: string;
  wordCount: number;
}

export interface ScoreResult {
  marks: number;
  rationale: string;
  strengths: string[];
  improvements: string[];
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  concerns: AiConcern[];
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface RoleExamState {
  inProgress: number;
  isOpen: boolean;
  windowEnd: Date | null;
}

export interface AiEvaluationRepository {
  roleExamState(jobRoleId: string): Promise<RoleExamState | null>;
  gradableQuestions(scope: { jobRoleId: string } | { attemptIds: string[] }): Promise<GradableQuestion[]>;
  createRun(data: {
    jobRoleId: string | null;
    model: string;
    promptVersion: string;
    createdById: string;
    items: { attemptQuestionId: string; maxMarks: number }[];
  }): Promise<{ run: RunRow; scoreIds: string[] }>;
  listRuns(jobRoleId: string | undefined): Promise<RunRow[]>;
  loadForGrading(scoreId: string): Promise<ScoreForGrading | null>;
  /** QUEUED -> DONE plus run counters; false when the score was no longer QUEUED (e.g. cancelled). */
  completeScore(scoreId: string, result: ScoreResult, at: Date): Promise<boolean>;
  /** QUEUED -> FAILED plus run counters; false when the score was no longer QUEUED. */
  failScore(scoreId: string, error: string, at: Date): Promise<boolean>;
  /** Marks a RUNNING run CANCELLED and its QUEUED scores FAILED('cancelled'); null when not found / not running. */
  cancelRun(runId: string, at: Date): Promise<{ run: RunRow; cancelledScoreIds: string[] } | { notRunning: true } | null>;
}

export interface AiEvaluationDeps {
  repo: AiEvaluationRepository;
  getConfig: () => Promise<AiConfig>;
  grader: AiGrader;
  /** Adds one job per score id (job id `ai-{scoreId}`). */
  enqueue: (scoreIds: string[]) => Promise<void>;
  /** Removes waiting jobs for cancelled scores. */
  removeJobs: (scoreIds: string[]) => Promise<void>;
  audit: (entry: { adminId: string; action: string; entity: string; entityId?: string; metadata?: Record<string, unknown>; ip?: string | null }) => Promise<void>;
  now?: () => Date;
}

export interface AiActor {
  id: string;
  ip: string | null;
}

const NOT_CONFIGURED = 'AI evaluation is not set up. Enable it and add an API key and model in Integrations.';
const ENTITY = 'ai_evaluation_run';

export const toRunDto = (r: RunRow): AiRunDto => ({
  id: r.id,
  jobRole: r.jobRole,
  model: r.model,
  promptVersion: r.promptVersion,
  status: r.status,
  total: r.total,
  done: r.done,
  failed: r.failed,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  createdByName: r.createdBy?.name ?? null,
  createdAt: r.createdAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

/** The exam is over for a role: nobody is mid-exam and it is closed or past its window. */
export function isExamOver(state: RoleExamState, now: Date): boolean {
  if (state.inProgress > 0) return false;
  return !state.isOpen || (state.windowEnd !== null && state.windowEnd.getTime() < now.getTime());
}

const KNOWN_CONCERNS = new Set<string>(AI_CONCERNS);

export function createAiEvaluationService(deps: AiEvaluationDeps) {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());

  async function start(input: AiRunStartInput, actor: AiActor): Promise<AiRunStartResultDto> {
    const cfg = await deps.getConfig();
    if (!isAiReady(cfg)) throw new AppError(409, 'AI_NOT_CONFIGURED', NOT_CONFIGURED);

    let scope: { jobRoleId: string } | { attemptIds: string[] };
    if (input.jobRoleId) {
      const state = await repo.roleExamState(input.jobRoleId);
      if (!state) throw notFound('Job role not found');
      if (!isExamOver(state, now())) {
        throw new AppError(409, 'EXAM_NOT_OVER', 'The exam is not over yet. Close it (or wait for the window to end) and make sure nobody is still attempting it.');
      }
      scope = { jobRoleId: input.jobRoleId };
    } else {
      scope = { attemptIds: input.attemptIds ?? [] };
    }

    const questions = await repo.gradableQuestions(scope);
    const todo = questions.filter((q) => !q.hasQueued && (input.force === true || !q.hasDone));
    const alreadyScored = questions.length - todo.length;
    if (todo.length === 0) return { run: null, queued: 0, alreadyScored };

    const { run, scoreIds } = await repo.createRun({
      jobRoleId: input.jobRoleId ?? null,
      model: cfg.model,
      promptVersion: PROMPT_VERSION,
      createdById: actor.id,
      items: todo.map((q) => ({ attemptQuestionId: q.attemptQuestionId, maxMarks: q.maxMarks })),
    });
    try {
      await deps.enqueue(scoreIds);
    } catch (err) {
      await repo.cancelRun(run.id, now());
      throw err;
    }
    await deps.audit({
      adminId: actor.id,
      action: 'AI_EVALUATION_STARTED',
      entity: ENTITY,
      entityId: run.id,
      metadata: { jobRoleId: input.jobRoleId ?? null, model: cfg.model, promptVersion: PROMPT_VERSION, questions: scoreIds.length, force: input.force === true },
      ip: actor.ip,
    });
    return { run: toRunDto(run), queued: scoreIds.length, alreadyScored };
  }

  async function list(jobRoleId: string | undefined): Promise<AiRunDto[]> {
    return (await repo.listRuns(jobRoleId)).map(toRunDto);
  }

  async function cancel(runId: string, actor: AiActor): Promise<AiRunDto> {
    const r = await repo.cancelRun(runId, now());
    if (!r) throw notFound('Run not found');
    if ('notRunning' in r) throw conflict('This run has already finished');
    await deps.removeJobs(r.cancelledScoreIds);
    await deps.audit({
      adminId: actor.id,
      action: 'AI_EVALUATION_CANCELLED',
      entity: ENTITY,
      entityId: runId,
      metadata: { cancelled: r.cancelledScoreIds.length },
      ip: actor.ip,
    });
    return toRunDto(r.run);
  }

  /**
   * Queue job body for one score. A no-op unless the score is still QUEUED in a
   * RUNNING run (stale or duplicate jobs are harmless). Throws to retry; on the
   * final attempt the score is stored FAILED first, then the error is rethrown.
   */
  async function processScore(scoreId: string, opts: { finalAttempt: boolean }): Promise<void> {
    const row = await repo.loadForGrading(scoreId);
    if (!row || row.status !== 'QUEUED' || row.runStatus !== 'RUNNING') return;
    try {
      const cfg = await deps.getConfig();
      if (!hasAiCredentials(cfg)) throw new AiProviderError('AI evaluation is no longer configured');
      const prompt = buildPrompt({
        questionText: row.questionText,
        maxMarks: row.maxMarks,
        guidance: row.guidance,
        answerText: row.answerText,
        wordCount: row.wordCount,
        extraInstructions: cfg.gradingInstructions,
      });
      const graded = await deps.grader.grade({ model: cfg.model, system: prompt.system, user: prompt.user });
      const parsed = AiGradeOutputSchema.safeParse(graded.output);
      if (!parsed.success) throw new AiOutputError();
      const out = parsed.data;
      await repo.completeScore(
        scoreId,
        {
          marks: normaliseMarks(out.marks, row.maxMarks),
          rationale: out.rationale,
          strengths: out.strengths,
          improvements: out.improvements,
          confidence: out.confidence,
          concerns: out.concerns.filter((c) => KNOWN_CONCERNS.has(c)),
          model: graded.model,
          inputTokens: graded.inputTokens,
          outputTokens: graded.outputTokens,
        },
        now(),
      );
    } catch (err) {
      if (opts.finalAttempt) await repo.failScore(scoreId, safeErrorText(err), now());
      throw err;
    }
  }

  /** One tiny structured call with the saved key and model (Integrations "Test connection"). */
  async function testConnection(): Promise<{ model: string }> {
    const cfg = await deps.getConfig();
    if (!hasAiCredentials(cfg)) throw new AppError(409, 'AI_NOT_CONFIGURED', 'Save an API key and a model first.');
    const prompt = buildPrompt({
      questionText: 'What is 2 + 2?',
      maxMarks: 1,
      guidance: 'Full marks for 4.',
      answerText: 'The answer is 4.',
      wordCount: 4,
    });
    const r = await deps.grader.grade({ model: cfg.model, system: prompt.system, user: prompt.user });
    return { model: r.model };
  }

  return { start, list, cancel, processScore, testConnection };
}

export type AiEvaluationService = ReturnType<typeof createAiEvaluationService>;
