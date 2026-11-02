// src/lib/importState.ts
// Why: the import wizard's step logic as a pure reducer so the 409 "already imported"
// -> "Import anyway" path is testable without rendering. Actions that don't fit the
// current step are ignored, so a late response can't drag the wizard backwards.

export interface ImportRowError {
  row: number;
  field: string;
  message: string;
}

export interface ImportDuplicate {
  row: number;
  reason: 'IN_FILE' | 'EXISTS';
}

export interface ImportPreview<V = unknown> {
  previewId: string;
  fileHash: string;
  summary: { total: number; valid: number; errors: number; duplicates: number; updates?: number };
  valid: V[];
  errors: ImportRowError[];
  duplicates: ImportDuplicate[];
  /** Candidate import with "update existing candidates" ticked. */
  updates?: V[];
  /** 1-based file rows that become a new role for an existing person (docs/multi-exam.md). Optional until the API ships. */
  linkedRows?: number[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  updated?: number;
}

export type ImportStep = 'choose' | 'preview' | 'done';

export interface ImportState<V = unknown> {
  step: ImportStep;
  preview: ImportPreview<V> | null;
  /** Set after a 409: the next confirm is sent with force:true. */
  canForce: boolean;
  conflictMessage: string | null;
  result: ImportResult | null;
}

export type ImportAction<V = unknown> =
  | { type: 'PREVIEW_OK'; preview: ImportPreview<V> }
  | { type: 'CONFIRM_CONFLICT'; message: string }
  | { type: 'CONFIRM_OK'; result: ImportResult }
  | { type: 'BACK' }
  | { type: 'RESET' };

export const initialImportState: ImportState<never> = {
  step: 'choose',
  preview: null,
  canForce: false,
  conflictMessage: null,
  result: null,
};

export function importReducer<V>(state: ImportState<V>, action: ImportAction<V>): ImportState<V> {
  switch (action.type) {
    case 'PREVIEW_OK':
      if (state.step !== 'choose') return state;
      return { ...state, step: 'preview', preview: action.preview, canForce: false, conflictMessage: null, result: null };
    case 'CONFIRM_CONFLICT':
      if (state.step !== 'preview') return state;
      return { ...state, canForce: true, conflictMessage: action.message };
    case 'CONFIRM_OK':
      if (state.step !== 'preview') return state;
      return { ...state, step: 'done', canForce: false, conflictMessage: null, result: action.result };
    case 'BACK':
      if (state.step !== 'preview') return state;
      return initialImportState as ImportState<V>;
    case 'RESET':
      return initialImportState as ImportState<V>;
  }
}
