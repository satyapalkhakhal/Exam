// modules/exam/exam.service.ts
// The exam engine (design §7.3–§7.6). The server owns the clock: endsAt is
// fixed at start, every response carries serverNow, and saves are refused once
// endsAt + 10 s has passed. The server also owns the session: start and resume
// issue an attempt-session id and only saves/events carrying it are accepted,
// so a second window cannot silently overwrite the first. Saves carry a client
// sequence; an older one is acknowledged as STALE and never written, so a late
// request can never replace newer text. Integrity evidence (bulk-insert flags,
// blocked pastes, tab/IP changes) is written with the server's own time.
// Every query is scoped by the candidate id from the verified token.

import crypto from 'node:crypto';
import { countWords, examAvailability, type ExamEventsInput, type ExamStartInput, type ExamState, type ExamSummaryDto, type SaveAnswerInput, type SaveAnswerResult } from '@exam/shared';
import { logger } from '../../infrastructure/logger/logger.js';
import { AppError, conflict, forbidden, notFound } from '../../shared/errors.js';
import type { ClientInfo } from '../../shared/utils/clientInfo.js';
import { SAVE_GRACE_MS } from '../../infrastructure/queue/autoSubmit.queue.js';
import { assessSave } from './integrity.js';
import { flagScore, type CandidateFlags } from './flagScore.js';
import { evaluateLocationFlags, LOCATION_FLAG_THRESHOLDS, type LocationFlag } from './locationFlags.js';
import type { ActivityEntry, ExamRepository, LiveAttempt } from './exam.repository.js';

/** A version row at most this often per answer (design §7.5). */
export const VERSION_INTERVAL_MS = 30_000;
/** Other candidates' starts this close in time count for the nearby flag. */
export const NEARBY_WINDOW_MS = 2 * 3_600_000;
const SYSTEM_IP = 'system';
/** A mass start queues for connections; wait for one rather than failing after Prisma's 2 s default. */
const START_TX = { maxWait: 10_000, timeout: 15_000 };

const attemptLocked = () => new AppError(409, 'ATTEMPT_LOCKED', 'This exam has been submitted and can no longer be changed.');
const superseded = () => new AppError(409, 'SESSION_SUPERSEDED', 'This exam is open in another window.');

export interface ExamServiceDeps {
  repo: ExamRepository;
  getSettings: (jobRoleId: string) => Promise<{ durationMinutes: number; isOpen: boolean; windowStart: Date | null; windowEnd: Date | null } | null>;
  recordStartLocation: (auth: { id: string; sessionFamily: string }, location: ExamStartInput['location'], client: ClientInfo) => Promise<void>;
  queue: { enqueue: (attemptId: string, endsAt: Date) => Promise<void>; remove: (attemptId: string) => Promise<void> };
  bindFamily: (family: string, candidateId: string) => Promise<void>;
  now?: () => Date;
}

export interface IntegrityCounts {
  pasteAttempts: number;
  bulkInsert: number;
  tabHidden: number;
  blur: number;
  ipChanges: number;
}

const INTEGRITY_EVENTS: Record<string, keyof IntegrityCounts> = {
  PASTE_ATTEMPT: 'pasteAttempts',
  COPY_ATTEMPT: 'pasteAttempts',
  CUT_ATTEMPT: 'pasteAttempts',
  DROP_ATTEMPT: 'pasteAttempts',
  SUSPICIOUS_BULK_INSERT: 'bulkInsert',
  TAB_HIDDEN: 'tabHidden',
  WINDOW_BLUR: 'blur',
  IP_CHANGED: 'ipChanges',
};
const zeroCounts = (): IntegrityCounts => ({ pasteAttempts: 0, bulkInsert: 0, tabHidden: 0, blur: 0, ipChanges: 0 });

export function createExamService(deps: ExamServiceDeps) {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  type Auth = { id: string; sessionFamily: string };

  const pastGrace = (endsAt: Date, at: Date) => at.getTime() > endsAt.getTime() + SAVE_GRACE_MS;

  async function buildState(attemptId: string, sessionId?: string): Promise<ExamState> {
    const a = await repo.loadState(attemptId);
    if (!a) throw notFound('No exam attempt found.');
    if (a.status === 'RESET') throw notFound('No exam attempt found.');
    return {
      attemptId: a.id,
      ...(sessionId ? { sessionId } : {}),
      status: a.status,
      serverNow: now().toISOString(),
      startedAt: a.startedAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      durationMinutes: Math.round((a.endsAt.getTime() - a.startedAt.getTime()) / 60_000),
      questions: a.questions.map((q) => ({
        attemptQuestionId: q.id,
        order: q.order,
        text: q.textSnapshot,
        maxMarks: Number(q.maxMarksSnapshot),
        answer: {
          text: q.answer?.text ?? '',
          wordCount: q.answer?.wordCount ?? 0,
          clientSeq: q.answer?.clientSeq ?? 0,
          markedForReview: q.answer?.markedForReview ?? false,
          visited: q.answer?.visited ?? false,
          lastSavedAt: q.answer && q.answer.clientSeq > 0 ? q.answer.lastSavedAt.toISOString() : null,
        },
      })),
    };
  }

  /** An IN_PROGRESS attempt whose time (plus grace) is up is locked on read rather than waiting for the sweep. */
  async function settleExpired(attempt: LiveAttempt): Promise<LiveAttempt> {
    if (attempt.status !== 'IN_PROGRESS' || !pastGrace(attempt.endsAt, now())) return attempt;
    await autoSubmitAttempt(attempt.id);
    return (await repo.findLiveAttempt(attempt.candidateId)) ?? attempt;
  }

  async function bind(auth: Auth) {
    try {
      await deps.bindFamily(auth.sessionFamily, auth.id);
    } catch (err) {
      logger.warn('could not bind exam login family', { message: err instanceof Error ? err.message : 'unknown' });
    }
  }

  /** New attempt-session id for an IN_PROGRESS attempt (resume, or a repeated start). */
  async function takeOver(auth: Auth, attempt: LiveAttempt, client: ClientInfo): Promise<ExamState> {
    const sessionId = crypto.randomUUID();
    await repo.transaction(async (tx) => {
      await tx.setSession(attempt.id, sessionId);
      await tx.addActivity({
        candidateId: auth.id,
        attemptId: attempt.id,
        eventType: 'SESSION_TAKEOVER',
        ip: client.ip,
        sessionId,
        userAgent: client.userAgent,
      });
    });
    await bind(auth);
    return buildState(attempt.id, sessionId);
  }

  async function start(auth: Auth, input: ExamStartInput, client: ClientInfo): Promise<ExamState> {
    const candidate = await repo.findCandidate(auth.id);
    if (!candidate || !candidate.eligible) throw forbidden('You are not eligible to take this exam.');

    // A finished attempt answers ALREADY_ATTEMPTED whatever the window says now.
    // A running one is a repeated start (a Back gesture, a second tab): it takes
    // the session over before the window and location gates, because a started
    // candidate keeps their full duration past windowEnd (design §4) and their
    // location was checked when they first started.
    const prior = await repo.findLiveAttempt(auth.id);
    if (prior) {
      const settled = await settleExpired(prior);
      if (settled.status !== 'IN_PROGRESS') throw conflict('You have already taken this exam.', 'ALREADY_ATTEMPTED');
      return takeOver(auth, settled, client);
    }

    const settings = await deps.getSettings(candidate.jobRoleId);
    const availability = examAvailability(settings ?? { isOpen: false, windowStart: null, windowEnd: null }, now());
    if (availability === 'AFTER_WINDOW') throw new AppError(403, 'EXAM_WINDOW_CLOSED', 'The exam window has closed.');
    if (availability !== 'OPEN') throw new AppError(403, 'EXAM_NOT_OPEN', 'The exam is not open yet.');

    await deps.recordStartLocation(auth, input.location, client);
    if (!candidate.locationExempt && input.location.permission !== 'GRANTED') {
      throw new AppError(400, 'LOCATION_REQUIRED', 'Share your location to start the exam.');
    }

    const sessionId = crypto.randomUUID();
    const outcome = await repo.transaction(async (tx) => {
      // Role settings row first (the order question writes use; shared once the
      // role is locked), then the candidate row, then re-read the role under the
      // lock: a concurrent role change or a second start cannot slip between the
      // checks and the insert.
      if (!(await tx.holdRoleLocked(candidate.jobRoleId))) throw new AppError(403, 'EXAM_NOT_OPEN', 'The exam is not open yet.');
      const locked = await tx.lockCandidate(auth.id);
      if (!locked || !locked.eligible) throw forbidden('You are not eligible to take this exam.');
      if (locked.jobRoleId !== candidate.jobRoleId) throw conflict('Your exam role has just changed. Please try again.');
      const raced = await tx.findLiveAttempt(auth.id);
      if (raced) return { kind: 'existing', attempt: raced } as const;

      const questions = await tx.activeQuestions(locked.jobRoleId);
      if (questions.length === 0) throw new AppError(403, 'EXAM_NOT_OPEN', 'This exam has no questions yet.');
      const startedAt = now();
      const durationMinutes = settings?.durationMinutes ?? 60;
      const endsAt = new Date(startedAt.getTime() + durationMinutes * 60_000);
      const attemptId = await tx.createAttempt({
        candidateId: auth.id,
        startedAt,
        endsAt,
        sessionId,
        ip: client.ip,
        userAgent: client.userAgent,
        questions,
      });
      await tx.setCandidateStatus(auth.id, locked.status, 'IN_PROGRESS');
      await tx.addActivity({
        candidateId: auth.id,
        attemptId,
        eventType: 'EXAM_STARTED',
        ip: client.ip,
        sessionId,
        userAgent: client.userAgent,
        metadata: { questionCount: questions.length, durationMinutes },
      });
      return { kind: 'created', attemptId, endsAt } as const;
    }, START_TX);

    if (outcome.kind === 'existing') {
      if (outcome.attempt.status !== 'IN_PROGRESS') throw conflict('You have already taken this exam.', 'ALREADY_ATTEMPTED');
      return takeOver(auth, outcome.attempt, client);
    }
    try {
      await deps.queue.enqueue(outcome.attemptId, outcome.endsAt);
    } catch (err) {
      // The minute sweep still locks the attempt on time; never fail a start over the queue.
      logger.error('could not enqueue auto-submit', { attemptId: outcome.attemptId, message: err instanceof Error ? err.message : 'unknown' });
    }
    await bind(auth);
    return buildState(outcome.attemptId, sessionId);
  }

  async function liveAttempt(candidateId: string): Promise<LiveAttempt> {
    const attempt = await repo.findLiveAttempt(candidateId);
    if (!attempt) throw notFound('No exam attempt found.');
    return attempt;
  }

  /** The candidate's receipt: status, times and counts (no answer text, no marks). */
  async function getSummary(candidateId: string): Promise<ExamSummaryDto> {
    const attempt = await settleExpired(await liveAttempt(candidateId));
    const s = await repo.loadSummary(attempt.id);
    if (!s || s.status === 'RESET') throw notFound('No exam attempt found.');
    return {
      status: s.status,
      submitType: s.submitType,
      startedAt: s.startedAt.toISOString(),
      submittedAt: s.submittedAt?.toISOString() ?? null,
      questionCount: s.questionCount,
      answeredCount: s.answeredCount,
    };
  }

  async function getState(auth: Auth): Promise<ExamState> {
    const attempt = await settleExpired(await liveAttempt(auth.id));
    if (attempt.status === 'IN_PROGRESS') await bind(auth);
    return buildState(attempt.id);
  }

  async function resume(auth: Auth, client: ClientInfo): Promise<ExamState> {
    const attempt = await settleExpired(await liveAttempt(auth.id));
    if (attempt.status !== 'IN_PROGRESS') throw attemptLocked();
    return takeOver(auth, attempt, client);
  }

  /** IP_CHANGED when the request comes from a different IP than the attempt's last logged event. */
  async function noteIp(candidateId: string, attemptId: string, client: ClientInfo, sessionId: string): Promise<void> {
    const last = await repo.lastActivityIp(attemptId);
    if (last === null || last === client.ip || last === SYSTEM_IP) return;
    await repo.addActivity({
      candidateId,
      attemptId,
      eventType: 'IP_CHANGED',
      ip: client.ip,
      sessionId,
      userAgent: client.userAgent,
      metadata: { from: last, to: client.ip },
    });
  }

  async function saveAnswer(auth: Auth, attemptQuestionId: string, input: SaveAnswerInput, client: ClientInfo): Promise<SaveAnswerResult> {
    const result = await repo.transaction(async (tx) => {
      const locked = await tx.lockForSave(attemptQuestionId);
      if (!locked || locked.attempt.candidateId !== auth.id) throw notFound('Question not found.');
      const { attempt, answer } = locked;
      const at = now();
      if (attempt.status !== 'IN_PROGRESS' || pastGrace(attempt.endsAt, at)) throw attemptLocked();
      if (input.sessionId !== attempt.activeSessionId) throw superseded();
      if (input.clientSeq <= answer.clientSeq) return { accepted: false, reason: 'STALE' } as const;

      const assessment = assessSave({
        prevLength: answer.text.length,
        newLength: input.text.length,
        typedChars: input.typedChars,
        restoredChars: input.restoredChars ?? 0,
        intervalMs: input.intervalMs,
      });
      const wordCount = countWords(input.text);
      await tx.updateAnswer(answer.id, {
        text: input.text,
        wordCount,
        clientSeq: input.clientSeq,
        savedAt: at,
        ...(input.markedForReview !== undefined ? { markedForReview: input.markedForReview } : {}),
        ...(input.visited !== undefined ? { visited: input.visited } : {}),
        flagged: assessment.flagged,
      });
      const lastVersion = await tx.lastVersionAt(answer.id);
      if (lastVersion === null || at.getTime() - lastVersion.getTime() >= VERSION_INTERVAL_MS) {
        await tx.addVersion(answer.id, input.text, wordCount, at);
      }
      if (assessment.flagged) {
        await tx.addActivity({
          candidateId: auth.id,
          attemptId: attempt.id,
          eventType: 'SUSPICIOUS_BULK_INSERT',
          questionId: attemptQuestionId,
          ip: client.ip,
          sessionId: input.sessionId,
          userAgent: client.userAgent,
          metadata: { grown: assessment.grown, typed: input.typedChars, restored: input.restoredChars ?? 0, rate: assessment.rate, reasons: assessment.reasons },
        });
      }
      return { accepted: true, serverNow: at.toISOString(), lastSavedAt: at.toISOString(), attemptId: attempt.id } as const;
    });
    if (!result.accepted) return result;
    await noteIp(auth.id, result.attemptId, client, input.sessionId);
    return { accepted: true, serverNow: result.serverNow, lastSavedAt: result.lastSavedAt };
  }

  /** The attempt behind a save/event/submit: the candidate's own, in progress, in this session. */
  async function activeAttemptFor(auth: Auth, sessionId: string): Promise<LiveAttempt> {
    const attempt = await liveAttempt(auth.id);
    if (attempt.status !== 'IN_PROGRESS' || pastGrace(attempt.endsAt, now())) throw attemptLocked();
    if (sessionId !== attempt.activeSessionId) throw superseded();
    return attempt;
  }

  async function recordEvents(auth: Auth, input: ExamEventsInput, client: ClientInfo): Promise<{ recorded: number }> {
    const attempt = await activeAttemptFor(auth, input.sessionId);
    await noteIp(auth.id, attempt.id, client, input.sessionId);
    const own = await repo.attemptQuestionIds(attempt.id);
    const entries: ActivityEntry[] = input.events.map((e) => ({
      candidateId: auth.id,
      attemptId: attempt.id,
      eventType: e.type,
      questionId: e.questionId && own.has(e.questionId) ? e.questionId : null,
      ip: client.ip,
      sessionId: input.sessionId,
      userAgent: client.userAgent,
      metadata: { ...(e.metadata ?? {}), clientAt: e.at },
    }));
    await repo.addActivities(entries);
    return { recorded: entries.length };
  }

  async function submit(auth: Auth, sessionId: string, client: ClientInfo): Promise<{ status: 'SUBMITTED'; submittedAt: string }> {
    const attempt = await liveAttempt(auth.id);
    const at = now();
    const done = await repo.transaction(async (tx) => {
      // Status, deadline and session are checked under the attempt row lock, so a
      // tab superseded by a concurrent resume cannot submit.
      const current = await tx.lockAttempt(attempt.id);
      if (!current || current.status !== 'IN_PROGRESS' || pastGrace(current.endsAt, at)) throw attemptLocked();
      if (sessionId !== current.activeSessionId) throw superseded();
      const finished = await tx.finish(attempt.id, 'SUBMITTED', at, false);
      if (!finished) return false;
      const from = await tx.candidateStatus(auth.id);
      await tx.setCandidateStatus(auth.id, from, 'SUBMITTED');
      await tx.writeFinalVersions(attempt.id, at);
      await tx.addActivity({
        candidateId: auth.id,
        attemptId: attempt.id,
        eventType: 'EXAM_SUBMITTED',
        ip: client.ip,
        sessionId,
        userAgent: client.userAgent,
      });
      return true;
    });
    if (!done) throw attemptLocked();
    try {
      await deps.queue.remove(attempt.id);
    } catch (err) {
      // A leftover job is a no-op: autoSubmitAttempt only acts on IN_PROGRESS.
      logger.warn('could not remove auto-submit job', { attemptId: attempt.id, message: err instanceof Error ? err.message : 'unknown' });
    }
    return { status: 'SUBMITTED', submittedAt: at.toISOString() };
  }

  /**
   * Idempotent: locks the attempt as AUTO_SUBMITTED only while it is still
   * IN_PROGRESS and its endsAt has passed. Looked up by id alone, so a job left
   * behind by a reset (status RESET) or a manual submit does nothing, and can
   * never touch the candidate's newer attempt.
   */
  async function autoSubmitAttempt(attemptId: string, at: Date = now()): Promise<boolean> {
    return repo.transaction(async (tx) => {
      const finished = await tx.finish(attemptId, 'AUTO_SUBMITTED', at, true);
      if (!finished) return false;
      const from = await tx.candidateStatus(finished.candidateId);
      await tx.setCandidateStatus(finished.candidateId, from, 'AUTO_SUBMITTED');
      await tx.writeFinalVersions(attemptId, at);
      await tx.addActivity({
        candidateId: finished.candidateId,
        attemptId,
        eventType: 'EXAM_AUTO_SUBMITTED',
        ip: SYSTEM_IP,
        metadata: { endsAt: finished.endsAt.toISOString() },
      });
      return true;
    });
  }

  const listExpiredAttemptIds = (cutoff: Date) => repo.listExpiredAttemptIds(cutoff);

  // ---- review flags ---------------------------------------------------------

  async function integrityFor(candidateIds: string[]): Promise<Map<string, IntegrityCounts>> {
    const out = new Map(candidateIds.map((id) => [id, zeroCounts()]));
    const rows = await repo.integrityEventCounts(candidateIds, Object.keys(INTEGRITY_EVENTS));
    for (const r of rows) {
      const field = INTEGRITY_EVENTS[r.eventType];
      const counts = out.get(r.candidateId);
      if (field && counts) counts[field] += r.count;
    }
    return out;
  }

  async function locationFlagsFor(candidateIds: string[]): Promise<Map<string, LocationFlag[]>> {
    const rows = await repo.locationRows(candidateIds);
    const per = new Map<string, typeof rows>();
    for (const r of rows) per.set(r.candidateId, [...(per.get(r.candidateId) ?? []), r]);

    const own = new Map<string, { login: { lat: number; lng: number } | null; start: { lat: number; lng: number; at: Date } | null; ips: string[] }>();
    for (const id of candidateIds) {
      const mine = per.get(id) ?? [];
      const granted = (stage: 'LOGIN' | 'EXAM_START', before?: Date) =>
        mine.filter((r) => r.stage === stage && r.permission === 'GRANTED' && r.lat !== null && r.lng !== null && (!before || r.createdAt <= before)).at(-1);
      const startRow = granted('EXAM_START');
      const loginRow = startRow ? granted('LOGIN', startRow.createdAt) : undefined;
      own.set(id, {
        start: startRow ? { lat: startRow.lat!, lng: startRow.lng!, at: startRow.createdAt } : null,
        login: loginRow ? { lat: loginRow.lat!, lng: loginRow.lng! } : null,
        ips: [...new Set(mine.filter((r) => r.stage === 'EXAM_START').map((r) => r.ip))],
      });
    }

    const startTimes = [...own.values()].flatMap((o) => (o.start ? [o.start.at.getTime()] : []));
    const nearbyPool =
      startTimes.length > 0
        ? await repo.grantedStartsBetween(new Date(Math.min(...startTimes) - NEARBY_WINDOW_MS), new Date(Math.max(...startTimes) + NEARBY_WINDOW_MS))
        : [];
    const ipCounts = await repo.startIpCandidateCounts([...new Set([...own.values()].flatMap((o) => o.ips))]);

    const out = new Map<string, LocationFlag[]>();
    for (const [id, o] of own) {
      const others = o.start
        ? nearbyPool
            .filter((p) => p.candidateId !== id && Math.abs(p.createdAt.getTime() - o.start!.at.getTime()) <= NEARBY_WINDOW_MS)
            .map((p) => ({ candidateId: p.candidateId, lat: p.lat, lng: p.lng }))
        : [];
      out.set(
        id,
        evaluateLocationFlags(
          { login: o.login, start: o.start ? { lat: o.start.lat, lng: o.start.lng } : null },
          others,
          o.ips.map((ip) => ({ ip, count: ipCounts.get(ip) ?? 0 })),
          LOCATION_FLAG_THRESHOLDS,
        ),
      );
    }
    return out;
  }

  async function computeLocationFlags(candidateId: string): Promise<LocationFlag[]> {
    return (await locationFlagsFor([candidateId])).get(candidateId) ?? [];
  }

  async function getFlags(candidateId: string): Promise<{ integrity: IntegrityCounts; location: LocationFlag[] }> {
    const [integrity, location] = await Promise.all([integrityFor([candidateId]), locationFlagsFor([candidateId])]);
    return { integrity: integrity.get(candidateId) ?? zeroCounts(), location: location.get(candidateId) ?? [] };
  }

  /** Integrity counts and location flags for many candidates in one pass. */
  async function getFlagsBatch(candidateIds: string[]): Promise<Map<string, CandidateFlags>> {
    const ids = [...new Set(candidateIds)];
    const [integrity, location] = await Promise.all([integrityFor(ids), locationFlagsFor(ids)]);
    return new Map(ids.map((id) => [id, { integrity: integrity.get(id) ?? zeroCounts(), location: location.get(id) ?? [] }]));
  }

  /** flagCount per candidate: flagScore of its flags. */
  async function getFlagCounts(candidateIds: string[]): Promise<Map<string, number>> {
    const flags = await getFlagsBatch(candidateIds);
    return new Map([...flags].map(([id, f]) => [id, flagScore(f)]));
  }

  return {
    getSummary,
    start,
    getState,
    resume,
    saveAnswer,
    recordEvents,
    submit,
    autoSubmitAttempt,
    listExpiredAttemptIds,
    computeLocationFlags,
    getFlags,
    getFlagsBatch,
    getFlagCounts,
  };
}

export type ExamService = ReturnType<typeof createExamService>;
