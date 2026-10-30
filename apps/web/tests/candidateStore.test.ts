import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markCandidateStatus, useCandidateAuth } from '../src/stores/candidateAuth.js';

const base = {
  id: 'c1',
  candidateCode: 'C-1',
  fullName: 'Test',
  email: 't@example.com',
  jobRole: { id: 'r1', name: 'Role' },
  status: 'NOT_STARTED',
  locationCaptured: true,
  locationExempt: false,
};

test('I1: a successful start marks the stored candidate IN_PROGRESS so Back shows Resume', () => {
  useCandidateAuth.getState().setCandidate({ ...base });
  markCandidateStatus('IN_PROGRESS');
  assert.equal(useCandidateAuth.getState().candidate?.status, 'IN_PROGRESS');
});

test('markCandidateStatus is a no-op when signed out', () => {
  useCandidateAuth.getState().clear();
  markCandidateStatus('IN_PROGRESS');
  assert.equal(useCandidateAuth.getState().candidate, null);
});
