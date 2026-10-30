import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIntegrationPatch } from '../src/lib/integrationsForm.js';

const saved = {
  enabled: true,
  baseUrl: 'https://x',
  userName: 'u',
  authToken: { set: true, last4: '1234' },
  apiKey: { set: false, last4: null },
};

test('an untouched secret is omitted so the saved one is kept', () => {
  const patch = buildIntegrationPatch(
    { enabled: true, baseUrl: 'https://x', userName: 'u', authToken: '', apiKey: '' },
    saved,
  );
  assert.equal('authToken' in patch, false);
  assert.equal('apiKey' in patch, false);
});

test('a whitespace-only secret counts as untouched', () => {
  const patch = buildIntegrationPatch({ enabled: true, authToken: '   ' }, saved);
  assert.equal('authToken' in patch, false);
});

test('a replaced secret is included, trimmed', () => {
  const patch = buildIntegrationPatch({ enabled: true, authToken: '  Basic abc  ' }, saved);
  assert.equal(patch.authToken, 'Basic abc');
});

test('plain text fields are trimmed and the switch is passed through', () => {
  const patch = buildIntegrationPatch({ enabled: false, baseUrl: '  https://y  ', userName: ' bob ' }, saved);
  assert.deepEqual(patch, { enabled: false, baseUrl: 'https://y', userName: 'bob' });
});
