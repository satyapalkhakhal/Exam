// Campus hiring dashboard payload (spec 2026-11-11): a Super Admin's per-drive rows
// carry the college and the evaluated exam % (sum + count, so averages across drives
// weight by candidates); an Evaluator's per-round rows carry none of it (blind marking).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COMPOSITE_WEIGHTS } from '@exam/shared';
import { createResultsService } from '../src/modules/results/results.service.js';
import type { ResultDrive, ResultsRepository } from '../src/modules/results/results.repository.js';

const drive = (id: string, over: Partial<ResultDrive> = {}): ResultDrive => ({
  id, jobRoleId: 'j1', jobRoleName: 'Backend', jobProfileType: 'PLACEMENT', roundId: 'r1', roundNumber: 1,
  collegeId: 'c1', collegeName: 'IIT Guwahati', collegeShortCode: 'IITG', batch: 'Nov 2026', refApplicantCount: 0,
  weights: DEFAULT_COMPOSITE_WEIGHTS, ...over,
});

function service() {
  const repo = {
    drives: async () => [drive('d1'), drive('d2', { collegeId: 'c2', collegeName: 'NIT Trichy', collegeShortCode: 'NITT' })],
    statusCounts: async () => [{ driveId: 'd1', status: 'EVALUATED', result: null, count: 2 }],
    examPercentStats: async () => [{ driveId: 'd1', sum: 150, count: 2 }],
  } as unknown as ResultsRepository;
  return createResultsService({ repo, getFlagsBatch: async () => new Map(), emailReady: async () => true, sendEmails: async () => ({ batchId: 'b', queued: 0, skipped: [] }) });
}

const SA_ONLY = ['collegeId', 'collegeName', 'roundId', 'examPctSum', 'examPctCount'];

test('super admin rows carry college and exam % stats per drive', async () => {
  const { drives } = await service().dashboard('SUPER_ADMIN');
  const d1 = drives.find((d) => d.driveId === 'd1')!;
  const d2 = drives.find((d) => d.driveId === 'd2')!;
  assert.deepEqual(
    { c: d1.collegeId, n: d1.collegeName, r: d1.roundId, s: d1.examPctSum, k: d1.examPctCount },
    { c: 'c1', n: 'IIT Guwahati', r: 'r1', s: 150, k: 2 },
  );
  assert.deepEqual({ c: d2.collegeId, s: d2.examPctSum, k: d2.examPctCount }, { c: 'c2', s: 0, k: 0 });
});

test('evaluator rows carry no college, batch or exam % keys', async () => {
  const { drives } = await service().dashboard('EVALUATOR');
  assert.equal(drives.length, 1, 'one row per round');
  for (const k of SA_ONLY) assert.ok(!(k in drives[0]!), k);
  assert.equal(drives[0]!.collegeShortCode, null);
  assert.equal(drives[0]!.batch, null);
  assert.ok(!/IIT|NIT/.test(JSON.stringify(drives)));
});
