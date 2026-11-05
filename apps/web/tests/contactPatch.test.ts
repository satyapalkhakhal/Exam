import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactPatch } from '../src/lib/contactPatch.js';

test('contactPatch: nothing is sent while the contact is still masked', () => {
  assert.deepEqual(contactPatch(false, { email: 'a****z@x.test', mobile: '98******10' }), {});
});

test('contactPatch: once revealed, the email is lower-cased and a blank mobile clears it', () => {
  assert.deepEqual(contactPatch(true, { email: ' Asha.Rao@X.test ', mobile: '9876543210' }), { email: 'asha.rao@x.test', mobile: '9876543210' });
  assert.deepEqual(contactPatch(true, { email: 'a@x.test', mobile: '  ' }), { email: 'a@x.test', mobile: null });
});
