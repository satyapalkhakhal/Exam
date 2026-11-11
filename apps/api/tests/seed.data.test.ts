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

test('demo data goes into a DEMO college drive, batch "Demo" (spec 2026-11-10)', () => {
  assert.deepEqual(seedData.demo.college, { name: 'Demo College', shortCode: 'DEMO' });
  assert.equal(seedData.demo.batch, 'Demo');
});

test('demo data adds 2 MCQs (4 different options, one correct) to Backend Engineer Round 1 (spec 2026-11-10 MCQ)', () => {
  const mcqs = seedData.demo.mcqQuestions;
  assert.equal(mcqs.length, 2);
  for (const q of mcqs) {
    assert.equal(q.options.length, 4);
    assert.equal(new Set(q.options.map((o) => o.toLowerCase())).size, 4);
    assert.ok(Number.isInteger(q.correctOption) && q.correctOption >= 0 && q.correctOption <= 3);
    assert.ok(q.text.length >= 10);
  }
});
