import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importReducer, initialImportState, type ImportPreview } from '../src/lib/importState.js';

const preview: ImportPreview<{ a: number }> = {
  previewId: 'p1',
  fileHash: 'h',
  summary: { total: 3, valid: 1, errors: 1, duplicates: 1 },
  valid: [{ a: 1 }],
  errors: [{ row: 3, field: 'email', message: 'bad' }],
  duplicates: [{ row: 4, reason: 'EXISTS' }],
};

test('starts on the choose step', () => {
  assert.equal(initialImportState.step, 'choose');
});

test('PREVIEW_OK moves to preview and keeps the preview', () => {
  const s = importReducer(initialImportState, { type: 'PREVIEW_OK', preview });
  assert.equal(s.step, 'preview');
  assert.equal(s.preview?.previewId, 'p1');
  assert.equal(s.canForce, false);
});

test('CONFIRM_CONFLICT sets canForce and keeps the message, staying on preview', () => {
  const p = importReducer(initialImportState, { type: 'PREVIEW_OK', preview });
  const s = importReducer(p, { type: 'CONFIRM_CONFLICT', message: 'This file was already imported on 1 Nov' });
  assert.equal(s.step, 'preview');
  assert.equal(s.canForce, true);
  assert.equal(s.conflictMessage, 'This file was already imported on 1 Nov');
});

test('CONFIRM_OK moves to done with counts and clears canForce', () => {
  const p = importReducer(initialImportState, { type: 'PREVIEW_OK', preview });
  const c = importReducer(p, { type: 'CONFIRM_CONFLICT', message: 'dup' });
  const s = importReducer(c, { type: 'CONFIRM_OK', result: { imported: 1, skipped: 2 } });
  assert.equal(s.step, 'done');
  assert.deepEqual(s.result, { imported: 1, skipped: 2 });
  assert.equal(s.canForce, false);
});

test('actions that do not fit the current step are ignored', () => {
  const s = importReducer(initialImportState, { type: 'CONFIRM_OK', result: { imported: 1, skipped: 0 } });
  assert.equal(s.step, 'choose');
});

test('RESET and BACK return to the start', () => {
  const p = importReducer(initialImportState, { type: 'PREVIEW_OK', preview });
  assert.equal(importReducer(p, { type: 'BACK' }).step, 'choose');
  const d = importReducer(p, { type: 'CONFIRM_OK', result: { imported: 0, skipped: 0 } });
  assert.deepEqual(importReducer(d, { type: 'RESET' }), initialImportState);
});
