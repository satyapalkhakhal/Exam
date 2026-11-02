import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  insertAtCursor, unknownPlaceholders, nextRoundPayload, nextRoundLinkError, skipReasonLabel, placeholderText, EMPTY_NEXT_ROUND,
} from '../src/lib/emailTemplates.js';

test('insertAtCursor inserts and replaces a selection', () => {
  assert.deepEqual(insertAtCursor('Hi ,', 3, 3, '{firstName}'), { text: 'Hi {firstName},', cursor: 14 });
  assert.deepEqual(insertAtCursor('Hi XX!', 3, 5, '{role}'), { text: 'Hi {role}!', cursor: 9 });
  assert.equal(insertAtCursor('ab', 99, 99, 'X').text, 'abX');
});

test('placeholderText wraps once', () => {
  assert.equal(placeholderText('role'), '{role}');
  assert.equal(placeholderText('{role}'), '{role}');
});

test('unknownPlaceholders lists distinct unknown tokens', () => {
  const allowed = ['firstName', '{role}'];
  assert.deepEqual(unknownPlaceholders('Hi {firstName}, {role} {foo} {foo} {}', allowed), ['{foo}', '{}']);
  assert.deepEqual(unknownPlaceholders('plain', allowed), []);
});

test('nextRoundPayload drops blanks and converts IST to ISO', () => {
  assert.equal(nextRoundPayload(EMPTY_NEXT_ROUND), undefined);
  const p = nextRoundPayload({ ...EMPTY_NEXT_ROUND, name: ' Interview ', scheduledAt: '2026-11-10T10:00', confirmBy: '2026-11-08T18:30' });
  assert.deepEqual(p, { name: 'Interview', scheduledAt: '2026-11-10T04:30:00.000Z', confirmBy: '2026-11-08T13:00:00.000Z' });
});

test('nextRoundLinkError requires https', () => {
  assert.equal(nextRoundLinkError(''), null);
  assert.equal(nextRoundLinkError('https://meet.example.com/x'), null);
  assert.equal(nextRoundLinkError('http://x.com'), 'The link must start with https://');
  assert.equal(nextRoundLinkError('nope'), 'Enter a valid link');
});

test('skipReasonLabel is plain words', () => {
  assert.equal(skipReasonLabel('ALREADY_SENT'), 'Already received this email');
});
