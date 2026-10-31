import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRestoreBudget,
  attachPasteGuard,
  isBlockedInputType,
  isBlockedKey,
  isRestrictedShortcut,
  isTypedInputType,
  typedCharsFor,
  compositionTypedChars,
  MAX_TYPED_PER_INSERT,
  MAX_TYPED_PER_COMPOSITION,
  type BlockedKind,
} from '../src/lib/pasteGuard.js';

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

test('Ctrl+V -> PASTE', () => assert.equal(isBlockedKey(key('v', { ctrlKey: true })), 'PASTE'));
test('Cmd+V (caps) -> PASTE', () => assert.equal(isBlockedKey(key('V', { metaKey: true })), 'PASTE'));
test('Shift+Insert -> PASTE', () => assert.equal(isBlockedKey(key('Insert', { shiftKey: true })), 'PASTE'));
test('Ctrl+C -> COPY', () => assert.equal(isBlockedKey(key('c', { ctrlKey: true })), 'COPY'));
test('Ctrl+X -> CUT', () => assert.equal(isBlockedKey(key('x', { ctrlKey: true })), 'CUT'));
test('Ctrl+A is allowed (select-all)', () => assert.equal(isBlockedKey(key('a', { ctrlKey: true })), null));
test('plain v is allowed', () => assert.equal(isBlockedKey(key('v')), null));

test('print, save, view source and developer-tools shortcuts are restricted; normal keys are not', () => {
  for (const k of [
    key('F12'),
    key('p', { ctrlKey: true }),
    key('S', { metaKey: true }),
    key('u', { ctrlKey: true }),
    key('I', { ctrlKey: true, shiftKey: true }),
    key('J', { ctrlKey: true, shiftKey: true }),
    key('C', { ctrlKey: true, shiftKey: true }),
    { ...key('i', { metaKey: true }), altKey: true },
  ]) {
    assert.equal(isRestrictedShortcut(k), true, JSON.stringify(k));
  }
  for (const k of [key('p'), key('a', { ctrlKey: true }), key('z', { ctrlKey: true }), key('Enter'), key('c', { ctrlKey: true })]) {
    assert.equal(isRestrictedShortcut(k), false, JSON.stringify(k));
  }
});

test('attachPasteGuard swallows restricted shortcuts without reporting them', () => {
  const target = new EventTarget();
  const seen: BlockedKind[] = [];
  const detach = attachPasteGuard(target, (k) => seen.push(k));
  for (const k of [key('F12'), key('p', { ctrlKey: true }), key('I', { ctrlKey: true, shiftKey: true })]) {
    const e = ev('keydown', k);
    target.dispatchEvent(e);
    assert.equal(e.defaultPrevented, true, k.key);
  }
  assert.deepEqual(seen, [], 'not counted as integrity events');
  detach();
});

test('isBlockedInputType', () => {
  for (const t of ['insertFromPaste', 'insertFromPasteAsQuotation', 'insertFromDrop', 'insertReplacementText', 'insertFromYank']) {
    assert.equal(isBlockedInputType(t), true, t);
  }
  assert.equal(isBlockedInputType('insertText'), false);
  assert.equal(isBlockedInputType('deleteContentBackward'), false);
});

test('isTypedInputType', () => {
  for (const t of ['insertText', 'insertLineBreak', 'insertParagraph', 'insertCompositionText']) {
    assert.equal(isTypedInputType(t), true, t);
  }
  assert.equal(isTypedInputType('insertFromPaste'), false);
  assert.equal(isTypedInputType('deleteContentBackward'), false);
});

test('typedCharsFor caps insertText at 2 chars per event, 1 per line break, and defers composition', () => {
  assert.equal(MAX_TYPED_PER_INSERT, 2);
  assert.equal(typedCharsFor('insertText', 'a'), 1);
  assert.equal(typedCharsFor('insertText', 'ab'), 2);
  // execCommand('insertText', bigText), clipboard chips and suggestion strips arrive as insertText.
  assert.equal(typedCharsFor('insertText', 'x'.repeat(5000)), 2);
  assert.equal(typedCharsFor('insertLineBreak', null), 1);
  assert.equal(typedCharsFor('insertParagraph', null), 1);
  assert.equal(typedCharsFor('insertCompositionText', 'नमस'), 0);
  assert.equal(typedCharsFor('insertFromPaste', 'pasted'), 0);
});

test('compositionTypedChars counts only net new committed chars, capped per composition', () => {
  assert.equal(MAX_TYPED_PER_COMPOSITION, 30);
  assert.equal(compositionTypedChars(100, 105), 5, 'a 5-letter word');
  assert.equal(compositionTypedChars(100, 100), 0, 'Gboard re-commit of an existing word');
  assert.equal(compositionTypedChars(100, 98), 0, 'a correction that shortened the text');
  assert.equal(compositionTypedChars(100, 4100), 30, 'a huge commit is capped');
});

function ev(type: string, props: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true, bubbles: true });
  Object.assign(e, props);
  return e;
}

test('attachPasteGuard blocks and reports paste/copy/cut/drop/contextmenu/keys/beforeinput, and detaches', () => {
  const target = new EventTarget();
  const seen: BlockedKind[] = [];
  const detach = attachPasteGuard(target, (k) => seen.push(k));

  const cases: [Event, BlockedKind][] = [
    [ev('paste'), 'PASTE'],
    [ev('copy'), 'COPY'],
    [ev('cut'), 'CUT'],
    [ev('drop'), 'DROP'],
    [ev('contextmenu'), 'CONTEXT_MENU'],
    [ev('keydown', key('v', { ctrlKey: true })), 'PASTE'],
    [ev('beforeinput', { inputType: 'insertFromDrop' }), 'DROP'],
    [ev('beforeinput', { inputType: 'insertFromPaste' }), 'PASTE'],
  ];
  for (const [e, kind] of cases) {
    target.dispatchEvent(e);
    assert.equal(e.defaultPrevented, true, e.type);
    assert.equal(seen.at(-1), kind, e.type);
  }

  const over = ev('dragover');
  target.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  assert.equal(seen.length, cases.length, 'dragover is blocked but not reported');

  const typing = ev('beforeinput', { inputType: 'insertText', data: 'a' });
  target.dispatchEvent(typing);
  assert.equal(typing.defaultPrevented, false);

  const held = ev('keydown', { ...key('v', { ctrlKey: true }), repeat: true });
  target.dispatchEvent(held);
  assert.equal(held.defaultPrevented, true);
  assert.equal(seen.length, cases.length, 'auto-repeat is blocked but reported once');

  detach();
  const after = ev('paste');
  target.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false);
  assert.equal(seen.length, cases.length);
});

test('I4: Undo after deleting a sentence is credited back up to what was deleted', () => {
  const b = createRestoreBudget();
  assert.equal(b.apply('deleteContentBackward', 1000, 880), 0, 'a delete banks 120');
  assert.equal(b.apply('historyUndo', 880, 1000), 120, 'Undo brings the 120 back as restored');
  assert.equal(b.apply('historyRedo', 1000, 1100), 0, 'nothing left in the bank');
});

test('I4: Undo/Redo can never restore more than was deleted; typing growth is never credited', () => {
  const b = createRestoreBudget();
  assert.equal(b.apply('insertText', 0, 1), 0);
  assert.equal(b.apply('deleteWordBackward', 500, 490), 0);
  assert.equal(b.apply('historyUndo', 490, 1200), 10, 'capped at the 10 deleted');
  assert.equal(b.apply(null, 1200, 1300), 0, 'unknown growth is not restored');
  // Undoing typing shrinks the text; Redo puts the same characters back.
  assert.equal(b.apply('historyUndo', 1300, 1250), 0);
  assert.equal(b.apply('historyRedo', 1250, 1300), 50);
});
