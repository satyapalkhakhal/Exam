// src/lib/examMcq.ts
// Why: MCQs on the exam screen (spec 2026-11-10 MCQ questions). A choice rides the same
// autosaver as typed text, encoded as a one-character value ('' = no choice, '0'–'3'),
// so it gets the same guarantees: per-question clientSeq, STALE resolution, retries,
// supersede/lock stops and the storage mirror. The page sends MCQ payloads to the choice
// endpoint (toChoiceBody). Palette grouping and the negative-marking wording live here too.

import { countWords } from '@exam/shared';
import type { PaletteItem, PaletteState } from '@/components/exam/QuestionPalette';
import type { SavePayload } from './autosave';
import type { ExamQuestion, ExamQuestionType } from '@/types/exam';

export const encodeChoice = (n: number | null): string => (n === null ? '' : String(n));

export function decodeChoice(s: string): number | null {
  if (!/^[0-3]$/.test(s)) return null;
  return Number(s);
}

/** What the autosaver holds for a question: the text, or an MCQ's encoded choice. */
export const answerValue = (q: ExamQuestion): string => (q.type === 'MCQ' ? encodeChoice(q.answer.selectedOption) : q.answer.text);

export const isAnswered = (type: ExamQuestionType, value: string): boolean => (type === 'MCQ' ? decodeChoice(value) !== null : countWords(value) > 0);

export interface ChoiceBody {
  clientSeq: number;
  selectedOption: number | null;
  markedForReview?: boolean;
  visited?: boolean;
}

export function toChoiceBody(p: SavePayload): ChoiceBody {
  return {
    clientSeq: p.clientSeq,
    selectedOption: decodeChoice(p.text),
    ...(p.markedForReview !== undefined ? { markedForReview: p.markedForReview } : {}),
    ...(p.visited !== undefined ? { visited: p.visited } : {}),
  };
}

export interface LocalAnswer {
  text: string;
  markedForReview: boolean;
  visited: boolean;
}

export interface PaletteGroup {
  title: string;
  items: PaletteItem[];
}

/** "Multiple choice" then "Written" (empty groups left out); numbers run across both, in exam order. */
export function paletteGroups(questions: ExamQuestion[], answers: Record<string, LocalAnswer>): PaletteGroup[] {
  const ordered = [...questions].sort((a, b) => a.order - b.order);
  const item = (q: ExamQuestion, i: number): PaletteItem => {
    const a = answers[q.attemptQuestionId];
    const state: PaletteState = a?.markedForReview ? 'marked' : a && isAnswered(q.type, a.text) ? 'answered' : a?.visited ? 'unanswered' : 'not-visited';
    return { id: q.attemptQuestionId, number: i + 1, state };
  };
  const items = ordered.map((q, i) => ({ q, it: item(q, i) }));
  return [
    { title: 'Multiple choice', items: items.filter((x) => x.q.type === 'MCQ').map((x) => x.it) },
    { title: 'Written', items: items.filter((x) => x.q.type !== 'MCQ').map((x) => x.it) },
  ].filter((g) => g.items.length > 0);
}

/** The rule shown on the start page and the MCQ section; null when there is no negative marking. */
export function negativeMarkingText(n: number): string | null {
  return n > 0 ? `Wrong MCQ answers: −${n} marks. Unanswered: 0.` : null;
}
