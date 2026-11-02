// tests/candidateAuth.account.test.ts
// Sign-in is keyed by the candidate account (docs/multi-exam.md): email or
// mobile finds the account, the OTP subject, tokens and refresh subject are the
// account id, and access needs at least one eligible application.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { setRedisClient } from '../src/infrastructure/redis/redis.js';
import { AppError } from '../src/shared/errors.js';
import { createCandidateAuthService, type CandidateAccountRecord, type CandidateAuthRepository, type LocationEntry } from '../src/modules/candidateAuth/candidateAuth.service.js';
import { verifyAccess } from '../src/modules/adminAuth/tokens.js';
import type { ClientInfo } from '../src/shared/utils/clientInfo.js';

const client = { ip: '10.0.0.1', userAgent: 'test', browser: 'Chrome', os: 'Linux', deviceType: 'desktop' } as unknown as ClientInfo;
beforeEach(() => setRedisClient(new RedisMock() as unknown as Redis));

const app = (id: string, over: Record<string, unknown> = {}) => ({ id, fullName: `Name ${id}`, rollNumber: null, eligible: true, locationExempt: false, ...over });

function setup(account: CandidateAccountRecord) {
  const issued: Array<{ subjectId: string; recipient: { email: string | null; mobile: string | null } }> = [];
  const verified: string[] = [];
  const locations: LocationEntry[] = [];
  const activity: string[] = [];
  const repo: CandidateAuthRepository = {
    findByIdentifier: async (id) => (id.includes('@') ? (account.email === id ? account : null) : account.mobile === id ? account : null),
    findById: async (id) => (id === account.id ? account : null),
    linkMobile: async () => 'linked',
    hasGrantedLogin: async () => false,
    recordLocation: async (e) => void locations.push(e),
    recordActivity: async (e) => void activity.push(`${e.candidateId}:${e.eventType}`),
  };
  const service = createCandidateAuthService({
    repo,
    audit: async () => {},
    otp: {
      issue: async (p) => void issued.push(p),
      verify: async (p) => {
        verified.push(p.subjectId);
        if (p.code !== '123456') throw new AppError(400, 'OTP_INVALID', 'Incorrect code.');
      },
    },
  });
  return { service, issued, verified, locations, activity };
}

const account = (apps = [app('a1'), app('a2')]): CandidateAccountRecord => ({ id: 'acc-1', email: 'p@x.in', mobile: '9876543210', applications: apps });

test('login by email and by mobile both find the account; the OTP subject is the account id', async () => {
  const f = setup(account());
  await f.service.requestOtp({ identifier: 'p@x.in', client });
  await f.service.requestOtp({ identifier: '9876543210', client });
  assert.deepEqual(f.issued.map((i) => i.subjectId), ['acc-1', 'acc-1']);
  assert.deepEqual(f.issued[0]!.recipient, { email: 'p@x.in', mobile: '9876543210' });
});

test('verify-otp signs the account in: token sub and refresh subject are the account id, self is account level', async () => {
  const f = setup(account());
  for (const identifier of ['p@x.in', '9876543210']) {
    const out = await f.service.verifyOtp({ identifier, code: '123456', client });
    assert.equal(verifyAccess('candidate', out.accessToken).sub, 'acc-1');
    assert.equal(out.candidate.id, 'acc-1');
    assert.equal(out.candidate.examCount, 2);
    assert.equal(out.candidate.fullName, 'Name a1', 'name from the most recent eligible application');
  }
  assert.equal(f.activity.filter((a) => a.endsWith('OTP_VERIFIED')).length, 4, 'logged on each eligible application');
});

test('an account with no eligible application is silent on request and OTP_INVALID on verify', async () => {
  const f = setup(account([app('a1', { eligible: false })]));
  assert.deepEqual(await f.service.requestOtp({ identifier: 'p@x.in', client }), { sent: true });
  assert.equal(f.issued.length, 0);
  await assert.rejects(f.service.verifyOtp({ identifier: 'p@x.in', code: '123456', client }), (e: unknown) => e instanceof AppError && e.code === 'OTP_INVALID');
  assert.equal(await f.service.isActive('acc-1'), false);
});

test('an ineligible application is not counted; locationExempt needs every eligible one exempt', async () => {
  const f = setup(account([app('a1', { locationExempt: true }), app('a2'), app('a3', { eligible: false })]));
  const me = (await f.service.me('acc-1', 'fam')).candidate;
  assert.equal(me.examCount, 2);
  assert.equal(me.locationExempt, false);
  const g = setup(account([app('a1', { locationExempt: true }), app('a3', { eligible: false })]));
  assert.equal((await g.service.me('acc-1', 'fam')).candidate.locationExempt, true);
});

test('LOGIN location is written once per eligible application; EXAM_START only for the one being started', async () => {
  const f = setup(account([app('a1'), app('a2'), app('a3', { eligible: false })]));
  await f.service.recordLocation({ id: 'acc-1', sessionFamily: 'fam' }, { stage: 'LOGIN', permission: 'GRANTED', latitude: 1, longitude: 2 }, client);
  assert.deepEqual(f.locations[0]!.candidateIds, ['a1', 'a2']);
  await f.service.recordLocation({ id: 'acc-1', sessionFamily: 'fam' }, { stage: 'EXAM_START', permission: 'DENIED' }, client, 'a2');
  assert.deepEqual(f.locations[1]!.candidateIds, ['a2']);
  assert.equal(f.locations[1]!.latitude, null);
  await assert.rejects(f.service.recordLocation({ id: 'acc-1', sessionFamily: 'fam' }, { stage: 'EXAM_START', permission: 'DENIED' }, client));
});
