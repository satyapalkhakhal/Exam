// Candidate code format: ARH-EX- plus a 6-digit zero-padded sequence number.

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCandidateCode } from '../src/modules/candidates/candidateCode.js';

test('7 formats as ARH-EX-000007', () => {
  assert.equal(formatCandidateCode(7), 'ARH-EX-000007');
});

test('a number past six digits is not truncated', () => {
  assert.equal(formatCandidateCode(1234567), 'ARH-EX-1234567');
});
