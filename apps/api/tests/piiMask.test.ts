import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskEmail, maskMobile } from '../src/shared/utils/piiMask.js';

test('maskEmail', () => {
  assert.equal(maskEmail('k.ajith@iitg.ac.in'), 'k****h@iitg.ac.in');
});
test('maskMobile', () => {
  assert.equal(maskMobile('9876543210'), '98******10');
});
