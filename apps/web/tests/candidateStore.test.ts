import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useCandidateAuth } from '../src/stores/candidateAuth.js';

const base = {
  id: 'a1',
  fullName: 'Test',
  email: 't@example.com',
  locationCaptured: false,
  locationExempt: false,
  examCount: 2,
};

test('stores the account-level candidate and clears it', () => {
  useCandidateAuth.getState().setCandidate({ ...base });
  assert.equal(useCandidateAuth.getState().candidate?.examCount, 2);
  const c = useCandidateAuth.getState().candidate!;
  useCandidateAuth.getState().setCandidate({ ...c, locationCaptured: true });
  assert.equal(useCandidateAuth.getState().candidate?.locationCaptured, true);
  useCandidateAuth.getState().clear();
  assert.equal(useCandidateAuth.getState().candidate, null);
});
