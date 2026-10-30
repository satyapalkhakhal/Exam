// tests/seed.data.test.ts
// Pins the seed's static data to design §4 and §10 so a typo in a role name or
// reference count is caught without needing a database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { seedData } from '../src/infrastructure/db/seed.data.js';

test('seeds the 7 job roles from design §4, in order', () => {
  assert.deepEqual(
    seedData.roles.map((r) => r.name),
    [
      'AI Product Manager - Trading & Wealth',
      'Product Management',
      'Customer Data Analytics & Engagement Specialist (CleverTap)',
      'Data Science / ML Engineer',
      'Backend Engineer',
      'Algo & Quant Profile',
      'AI & ML Engineer',
    ],
  );
});

test('reference applicant counts match design §4 and sum to 461', () => {
  assert.deepEqual(
    seedData.roles.map((r) => r.refApplicantCount),
    [33, 118, 16, 106, 36, 42, 110],
  );
  assert.equal(seedData.roles.reduce((s, r) => s + r.refApplicantCount, 0), 461);
});

test('system config seeds sms.arihant and email.zatpatmail, both disabled', () => {
  assert.deepEqual(seedData.configs.map((c) => c.key), ['sms.arihant', 'email.zatpatmail']);
  for (const c of seedData.configs) assert.equal(c.value.enabled, false);
});

test('demo data is 3 candidates and 2 questions for Backend Engineer', () => {
  assert.equal(seedData.demo.roleName, 'Backend Engineer');
  assert.equal(seedData.demo.candidates.length, 3);
  assert.equal(seedData.demo.questions.length, 2);
});
