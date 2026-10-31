import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesCandidateSearch } from '../src/lib/candidateSearch.js';

const row = { fullName: 'Aswajith K K', email: 'k.aswajith@iitg.ac.in', rollNumber: '254101009', candidateCode: 'ARH-EX-000123' };

test('matches name, email, roll number and code, case-insensitively and trimmed', () => {
  for (const q of ['aswajith', 'K.ASWAJITH@', '254101', 'arh-ex-000123', '  254101009 ']) {
    assert.equal(matchesCandidateSearch(row, q), true, q);
  }
});

test('empty search matches everything; a miss is false; missing fields are safe', () => {
  assert.equal(matchesCandidateSearch(row, ''), true);
  assert.equal(matchesCandidateSearch(row, 'zzz'), false);
  assert.equal(matchesCandidateSearch({ candidateCode: 'ARH-EX-1' }, '9999'), false);
});
