// Composite weights on exam settings: defaults in the DTO, validation (must add
// up to 100, exam above 0), and update passing weights through only when given.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COMPOSITE_WEIGHTS, ExamSettingsUpdateSchema } from '@exam/shared';
import { createJobRolesService, type ExamSettingRow, type ExamSettingsWrite, type JobRoleRow, type JobRolesRepository } from '../src/modules/jobRoles/jobRoles.service.js';

const base: ExamSettingRow = {
  durationMinutes: 60, windowStart: null, windowEnd: null, instructions: '', isOpen: false, questionsLocked: false,
  weightExam: 70, weightX: 10, weightXii: 10, weightCpi: 10,
};

function setup(setting: ExamSettingRow | null = base) {
  const writes: ExamSettingsWrite[] = [];
  const role = { id: 'r1', name: 'R', refApplicantCount: 0, active: true, examSetting: setting, _count: { questions: 0, candidates: 0 } } as JobRoleRow;
  const repo = {
    list: async () => [role],
    findById: async () => role,
    upsertSettings: async (_id: string, data: ExamSettingsWrite) => {
      writes.push(data);
      return { ...base, ...(data.weights ? { weightExam: data.weights.exam, weightX: data.weights.x, weightXii: data.weights.xii, weightCpi: data.weights.cpi } : {}) };
    },
  } as unknown as JobRolesRepository;
  return { service: createJobRolesService(repo), writes };
}

const update = { durationMinutes: 60, windowStart: null, windowEnd: null, instructions: '', isOpen: false };

test('the settings DTO carries the weights, defaulting when a role has no settings row', async () => {
  assert.deepEqual((await setup().service.list())[0]!.settings.weights, { exam: 70, x: 10, xii: 10, cpi: 10 });
  assert.deepEqual((await setup(null).service.list())[0]!.settings.weights, DEFAULT_COMPOSITE_WEIGHTS);
});

test('updateSettings passes weights through when given, and omits them when not', async () => {
  const { service, writes } = setup();
  const dto = await service.updateSettings('r1', { ...update, weights: { exam: 50, x: 20, xii: 20, cpi: 10 } }, 'admin', null);
  assert.deepEqual(writes[0]!.weights, { exam: 50, x: 20, xii: 20, cpi: 10 });
  assert.deepEqual(dto.weights, { exam: 50, x: 20, xii: 20, cpi: 10 });
  await service.updateSettings('r1', update, 'admin', null);
  assert.equal(writes[1]!.weights, undefined);
});

test('the update schema rejects weights that do not add up to 100 or give the exam no weight', () => {
  const parse = (weights: unknown) => ExamSettingsUpdateSchema.safeParse({ ...update, weights }).success;
  assert.equal(parse({ exam: 70, x: 10, xii: 10, cpi: 10 }), true);
  assert.equal(parse({ exam: 70, x: 10, xii: 10, cpi: 5 }), false);
  assert.equal(parse({ exam: 0, x: 40, xii: 30, cpi: 30 }), false);
  assert.equal(ExamSettingsUpdateSchema.safeParse(update).success, true);
});
