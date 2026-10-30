// src/lib/pasteGuard.ts
// Why: answers must be typed, not pasted (design 7.4). Browser-side blocking is only a
// deterrent: every blocked attempt is reported so it can be logged, and the typed-character
// count (typedCharsFor) is the evidence the server compares with real answer growth.

export type BlockedKind = 'PASTE' | 'COPY' | 'CUT' | 'DROP' | 'CONTEXT_MENU';

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const MOD_KEYS: Record<string, 'PASTE' | 'COPY' | 'CUT'> = { v: 'PASTE', c: 'COPY', x: 'CUT' };

export function isBlockedKey(e: KeyLike): 'PASTE' | 'COPY' | 'CUT' | null {
  if (e.shiftKey && e.key === 'Insert') return 'PASTE';
  if (e.ctrlKey || e.metaKey) return MOD_KEYS[e.key.toLowerCase()] ?? null;
  return null;
}

const BLOCKED_INPUT = new Set([
  'insertFromPaste',
  'insertFromPasteAsQuotation',
  'insertFromDrop',
  'insertReplacementText',
  'insertFromYank',
]);
const TYPED_INPUT = new Set(['insertText', 'insertLineBreak', 'insertParagraph', 'insertCompositionText']);

export const isBlockedInputType = (t: string): boolean => BLOCKED_INPUT.has(t);
export const isTypedInputType = (t: string): boolean => TYPED_INPUT.has(t);

/**
 * Typed-character evidence is capped per event so that bulk insertions that arrive as
 * "typing" (execCommand('insertText', big), Android clipboard chips, suggestion strips,
 * Gboard re-committing a word) cannot cover for themselves. A real keystroke adds 1 char,
 * 2 allows for auto-closed pairs; one composition (a swiped or IME word) adds at most 30.
 */
export const MAX_TYPED_PER_INSERT = 2;
export const MAX_TYPED_PER_COMPOSITION = 30;

/** Characters a `beforeinput` event adds by typing. IME composition is counted at compositionend. */
export function typedCharsFor(inputType: string, data: string | null | undefined): number {
  if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') return 1;
  if (inputType === 'insertText') return Math.min(data?.length ?? 0, MAX_TYPED_PER_INSERT);
  return 0;
}

/**
 * Undo/Redo credit (design 7.4). historyUndo/historyRedo add text without typing it, so an
 * honest "delete a sentence, Ctrl+Z" would look like a bulk insert. Every shrink of the
 * answer banks the removed characters; Undo/Redo growth is credited back only up to that
 * bank, so it can restore what was deleted but never bring in anything new.
 */
export interface RestoreBudget {
  /** Feed every change (inputType of the native input event); returns the restored characters to report. */
  apply(inputType: string | null | undefined, prevLength: number, nextLength: number): number;
}

export function createRestoreBudget(): RestoreBudget {
  let bank = 0;
  return {
    apply(inputType, prevLength, nextLength) {
      const growth = nextLength - prevLength;
      if (growth < 0) {
        bank += -growth;
        return 0;
      }
      if (growth === 0 || (inputType !== 'historyUndo' && inputType !== 'historyRedo')) return 0;
      const credit = Math.min(growth, bank);
      bank -= credit;
      return credit;
    },
  };
}

/** Net new characters one composition committed (text length at compositionstart vs end), capped. */
export function compositionTypedChars(lengthAtStart: number, lengthAtEnd: number): number {
  return Math.min(Math.max(0, lengthAtEnd - lengthAtStart), MAX_TYPED_PER_COMPOSITION);
}

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Blocks paste/copy/cut/drag-drop/context menu and their shortcuts on `target` (the answer
 * box or the whole document) and reports each attempt. Returns a detach function.
 */
export function attachPasteGuard(target: Listenable, onBlocked: (kind: BlockedKind, detail?: string) => void): () => void {
  const block = (kind: BlockedKind) => (e: Event) => {
    e.preventDefault();
    onBlocked(kind);
  };
  const handlers: Record<string, (e: Event) => void> = {
    paste: block('PASTE'),
    copy: block('COPY'),
    cut: block('CUT'),
    drop: block('DROP'),
    contextmenu: block('CONTEXT_MENU'),
    // Dragging text out (to copy it elsewhere) and hovering a drag are blocked silently;
    // only the drop itself is an attempt worth recording.
    dragstart: (e) => e.preventDefault(),
    dragover: (e) => e.preventDefault(),
    keydown: (e) => {
      const kind = isBlockedKey(e as unknown as KeyLike);
      if (!kind) return;
      e.preventDefault();
      if (!(e as KeyboardEvent).repeat) onBlocked(kind);
    },
    beforeinput: (e) => {
      const t = (e as InputEvent).inputType;
      if (!t || !isBlockedInputType(t)) return;
      e.preventDefault();
      onBlocked(t === 'insertFromDrop' ? 'DROP' : 'PASTE', t);
    },
  };
  for (const [type, h] of Object.entries(handlers)) target.addEventListener(type, h);
  return () => {
    for (const [type, h] of Object.entries(handlers)) target.removeEventListener(type, h);
  };
}
