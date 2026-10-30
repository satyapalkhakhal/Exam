// modules/questions/questionImport.parser.ts
// Pure row validation for the question import: no I/O, so the preview can be
// built (and unit-tested) from parsed rows plus the role's existing hashes.
// Row numbers are 1-based and count the header row, as Excel shows them, so
// the first data row is 2. Duplicates (same normalised text) are reported
// separately from errors and are skipped, not failed.

import { questionHash } from '../../shared/utils/questionHash.js';

export interface QuestionDraft {
  row: number;
  questionText: string;
  maxMarks: number;
  evaluatorGuidance: string | null;
  displayOrder: number | null;
}

export interface RowError {
  row: number;
  field: string;
  message: string;
}

export interface RowDuplicate {
  row: number;
  reason: 'IN_FILE' | 'EXISTS';
}

export interface ParsedQuestions {
  valid: QuestionDraft[];
  errors: RowError[];
  duplicates: RowDuplicate[];
}

export const TEMPLATE_COLUMNS = ['question_text', 'max_marks', 'evaluator_guidance', 'display_order'] as const;

// Filled-in reference file for admins, served apart from the header-only template.
// Shows half marks, a quoted value containing commas, and blank optional columns.
export const SAMPLE_CSV = [
  TEMPLATE_COLUMNS.join(','),
  '"Explain how you would design an idempotent order-placement API for a trading platform.",10,"Look for idempotency keys, safe retries, and exactly-once side effects.",1',
  '"Describe how you would find and fix a slow PostgreSQL query in production.",10,"Look for EXPLAIN ANALYZE, indexing, and awareness of locks on a live table.",2',
  '"What is the difference between optimistic and pessimistic locking? When would you use each?",7.5,"Version column vs SELECT ... FOR UPDATE; trade-off is contention vs retries.",3',
  '"How would you design a rate limiter for a public REST API?",7.5,"Token bucket or sliding window, a shared store such as Redis, per-key limits.",4',
  '"How would you make a webhook receiver safe against duplicate deliveries?",5,"Dedup on the event id, return 2xx fast, process asynchronously.",5',
  '"Explain what happens, step by step, when a client calls an HTTPS endpoint on your service.",5,,',
  '',
].join('\n');
export const TEXT_MIN = 10;
export const TEXT_MAX = 5000;

function parseMarks(raw: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  if (n < 0.5 || n > 100 || !Number.isInteger(n * 2)) return null;
  return n;
}

export function parseQuestionRows(
  rows: Record<string, string>[],
  existingHashes: Set<string>,
  rowNumbers?: number[],
): ParsedQuestions {
  const out: ParsedQuestions = { valid: [], errors: [], duplicates: [] };
  const seen = new Set<string>();

  rows.forEach((r, i) => {
    const row = rowNumbers?.[i] ?? i + 2;
    const rowErrors: RowError[] = [];
    const text = (r.question_text ?? '').trim();
    if (text.length < TEXT_MIN || text.length > TEXT_MAX) {
      rowErrors.push({ row, field: 'question_text', message: `Question text must be ${TEXT_MIN} to ${TEXT_MAX} characters` });
    }

    const marks = parseMarks((r.max_marks ?? '').trim());
    if (marks === null) {
      rowErrors.push({ row, field: 'max_marks', message: 'Max marks must be a number from 0.5 to 100 in steps of 0.5' });
    }

    const guidance = (r.evaluator_guidance ?? '').trim();
    if (guidance.length > TEXT_MAX) {
      rowErrors.push({ row, field: 'evaluator_guidance', message: `Evaluator guidance must be at most ${TEXT_MAX} characters` });
    }

    const orderRaw = (r.display_order ?? '').trim();
    let displayOrder: number | null = null;
    if (orderRaw !== '') {
      if (/^\d+$/.test(orderRaw) && Number(orderRaw) <= 100_000) displayOrder = Number(orderRaw);
      else rowErrors.push({ row, field: 'display_order', message: 'Display order must be a whole number of 0 or more' });
    }

    if (rowErrors.length > 0 || marks === null) {
      out.errors.push(...rowErrors);
      return;
    }

    const hash = questionHash(text);
    if (existingHashes.has(hash)) {
      out.duplicates.push({ row, reason: 'EXISTS' });
      return;
    }
    if (seen.has(hash)) {
      out.duplicates.push({ row, reason: 'IN_FILE' });
      return;
    }
    seen.add(hash);
    out.valid.push({ row, questionText: text, maxMarks: marks, evaluatorGuidance: guidance === '' ? null : guidance, displayOrder });
  });

  return out;
}
