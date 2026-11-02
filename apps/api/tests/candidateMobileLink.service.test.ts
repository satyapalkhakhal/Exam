// tests/candidateMobileLink.service.test.ts
// First-time mobile registration: email + roll number pick the account (through
// one of its eligible applications), the SMS code is bound to (account, mobile),
// the mobile links once to the account and all its applications, and every
// refusal looks the same to the caller.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { setRedisClient } from '../src/infrastructure/redis/redis.js';
import { AppError } from '../src/shared/errors.js';
import {
  createCandidateAuthService,
  type AccountApplication,
  type CandidateAuthDeps,
  type CandidateAccountRecord,
  type CandidateAuthRepository,
} from '../src/modules/candidateAuth/candidateAuth.service.js';
import type { AuditRecord } from '../src/modules/audit/audit.service.js';
import type { ClientInfo } from '../src/shared/utils/clientInfo.js';

const client: ClientInfo = { ip: '10.0.0.1', userAgent: 'test', browser: null, os: null, deviceType: null } as unknown as ClientInfo;
const EMAIL = 'k.aswajith@iitg.ac.in';
const ROLL = '254101009';
const MOBILE = '9876543210';

beforeEach(() => setRedisClient(new RedisMock() as unknown as Redis));

export const application = (id: string, over: Partial<AccountApplication> = {}): AccountApplication => ({
  id,
  fullName: 'Aswajith K K',
  rollNumber: ROLL,
  eligible: true,
  locationExempt: false,
  ...over,
});

/** `seed` overrides the account; `apps` replaces its applications (default: one eligible application a1). */
function setup(
  seed: Partial<CandidateAccountRecord> = {},
  others: CandidateAccountRecord[] = [],
  issueError?: AppError,
  apps: AccountApplication[] = [application('a1')],
) {
  const row: CandidateAccountRecord = { id: 'c1', email: EMAIL, mobile: null, applications: apps, ...seed };
  const all = [row, ...others];
  const activity: Array<{ candidateId: string; eventType: string; metadata?: Record<string, unknown> }> = [];
  const audits: AuditRecord[] = [];
  const issued: Array<{ purpose: string; subjectId: string; recipient: { email: string | null; mobile: string | null } }> = [];
  const verified: Array<{ purpose: string; subjectId: string }> = [];
  let linkOutcome: 'linked' | 'already_linked' | 'mobile_in_use' | null = null;

  const repo: CandidateAuthRepository = {
    findByIdentifier: async (id) => all.find((c) => (id.includes('@') ? c.email === id : c.mobile === id)) ?? null,
    findById: async (id) => all.find((c) => c.id === id) ?? null,
    linkMobile: async (id, mobile) => {
      if (linkOutcome) return linkOutcome;
      const c = all.find((x) => x.id === id)!;
      if (c.mobile !== null) return 'already_linked';
      c.mobile = mobile;
      return 'linked';
    },
    hasGrantedLogin: async () => false,
    recordLocation: async () => {},
    recordActivity: async (e) => void activity.push({ candidateId: e.candidateId, eventType: e.eventType, metadata: e.metadata }),
  };
  const deps: CandidateAuthDeps = {
    repo,
    audit: async (e) => void audits.push(e),
    otp: {
      issue: async (p) => {
        if (issueError) throw issueError;
        issued.push(p);
      },
      verify: async (p) => {
        verified.push(p);
        if ((p as { code: string }).code !== '123456') throw new AppError(400, 'OTP_INVALID', 'Incorrect code.');
      },
    },
  };
  return {
    row,
    activity,
    audits,
    issued,
    verified,
    forceLink: (o: typeof linkOutcome) => (linkOutcome = o),
    service: createCandidateAuthService(deps),
  };
}

const req = (over: Partial<{ email: string; rollNumber: string; mobile: string }> = {}) => ({
  email: EMAIL,
  rollNumber: ROLL,
  mobile: MOBILE,
  client,
  ...over,
});

const rejectsWith = async (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof AppError && e.code === code);

test('a matching email + roll number sends the code by SMS only, bound to (account, mobile)', async () => {
  const f = setup();
  assert.deepEqual(await f.service.requestMobileLink(req()), { sent: true });
  assert.equal(f.issued.length, 1);
  assert.equal(f.issued[0]!.purpose, 'candidate_mobile_link');
  assert.equal(f.issued[0]!.subjectId, `c1:${MOBILE}`);
  assert.deepEqual(f.issued[0]!.recipient, { email: null, mobile: MOBILE });
});

test('the roll number match ignores case and surrounding spaces', async () => {
  const f = setup({}, [], undefined, [application('a1', { rollNumber: 'AB12' })]);
  await f.service.requestMobileLink(req({ rollNumber: ' ab12 ' }));
  assert.equal(f.issued.length, 1);
});

test('unknown email, wrong roll number, no roll on file and ineligible all get the same reply and no SMS', async () => {
  for (const [seed, over] of [
    [{}, { email: 'ghost@iitg.ac.in' }],
    [{}, { rollNumber: '999' }],
    [{ apps: [application('a1', { rollNumber: null })] }, {}],
    [{ apps: [application('a1', { eligible: false })] }, {}],
  ] as const) {
    const f = setup({}, [], undefined, 'apps' in seed ? [...seed.apps] : undefined);
    assert.deepEqual(await f.service.requestMobileLink(req(over)), { sent: true });
    assert.equal(f.issued.length, 0);
    assert.equal(f.activity.length, 0);
  }
});

test('an account that already has a mobile gets no SMS, and the attempt is logged for HR', async () => {
  const f = setup({ mobile: '9000000001' });
  assert.deepEqual(await f.service.requestMobileLink(req()), { sent: true });
  assert.equal(f.issued.length, 0);
  assert.equal(f.activity[0]!.eventType, 'MOBILE_LINK_REFUSED');
  assert.equal(f.activity[0]!.metadata!.reason, 'already_linked');
  assert.equal(f.activity[0]!.metadata!.mobile, '98******10');
});

test("a mobile already on another candidate's record gets no SMS and is logged", async () => {
  const other: CandidateAccountRecord = { id: 'c2', email: 'x@iitg.ac.in', mobile: MOBILE, applications: [application('b1')] };
  const f = setup({}, [other]);
  assert.deepEqual(await f.service.requestMobileLink(req()), { sent: true });
  assert.equal(f.issued.length, 0);
  assert.equal(f.activity[0]!.metadata!.reason, 'mobile_in_use');
});

test('OTP_COOLDOWN surfaces; a delivery failure stays generic and is logged', async () => {
  await rejectsWith(setup({}, [], new AppError(429, 'OTP_COOLDOWN', 'wait')).service.requestMobileLink(req()), 'OTP_COOLDOWN');

  const f = setup({}, [], new AppError(502, 'OTP_DELIVERY_FAILED', 'no'));
  assert.deepEqual(await f.service.requestMobileLink(req()), { sent: true });
  assert.equal(f.activity[0]!.eventType, 'OTP_DELIVERY_FAILED');
  assert.equal(f.audits[0]!.action, 'CANDIDATE_OTP_FAILED');
});

test('verify with the right code links the mobile, logs it, and signs the candidate in', async () => {
  const f = setup();
  const out = await f.service.verifyMobileLink({ ...req(), code: '123456' });
  assert.deepEqual(f.verified[0], { purpose: 'candidate_mobile_link', subjectId: `c1:${MOBILE}`, code: '123456' });
  assert.equal(f.row.mobile, MOBILE);
  assert.equal(out.candidate.id, 'c1');
  assert.ok(out.accessToken && out.refreshToken);
  assert.equal(f.activity.at(-1)!.eventType, 'MOBILE_SELF_REGISTERED');
  assert.equal(f.audits.at(-1)!.action, 'CANDIDATE_MOBILE_SELF_REGISTERED');
});

test('the code is checked against the typed mobile, so a code sent to one number cannot link another', async () => {
  const f = setup();
  await rejectsWith(f.service.verifyMobileLink({ ...req({ mobile: '9123456789' }), code: '000000' }), 'OTP_INVALID');
  assert.equal(f.verified[0]!.subjectId, 'c1:9123456789');
  assert.equal(f.row.mobile, null);
});

test('verify refuses a wrong roll number, an ineligible candidate and an already-linked account with OTP_INVALID', async () => {
  for (const [seed, over] of [
    [{}, { rollNumber: '999' }],
    [{ apps: [application('a1', { eligible: false })] }, {}],
    [{ mobile: '9000000001' }, {}],
  ] as const) {
    const f = 'apps' in seed ? setup({}, [], undefined, [...seed.apps]) : setup(seed);
    await rejectsWith(f.service.verifyMobileLink({ ...req(over), code: '123456' }), 'OTP_INVALID');
    assert.equal(f.verified.length, 0, 'the code is not even checked');
  }
});

test('losing a race: mobile taken meanwhile is a 409, account linked meanwhile is OTP_INVALID; neither signs in', async () => {
  const taken = setup();
  taken.forceLink('mobile_in_use');
  await rejectsWith(taken.service.verifyMobileLink({ ...req(), code: '123456' }), 'CONFLICT');

  const linked = setup();
  linked.forceLink('already_linked');
  await rejectsWith(linked.service.verifyMobileLink({ ...req(), code: '123456' }), 'OTP_INVALID');
  assert.equal(linked.activity.length, 0);
});

test('mobile link across two applications: either roll number finds the account, and the refusal/registration is logged on each matching application', async () => {
  const apps = [application('a1', { rollNumber: 'R-1' }), application('a2', { rollNumber: 'R-2' })];
  const viaSecond = setup({}, [], undefined, apps);
  await viaSecond.service.requestMobileLink(req({ rollNumber: 'R-2' }));
  assert.equal(viaSecond.issued[0]!.subjectId, `c1:${MOBILE}`, 'the code is bound to the account, not the application');

  const done = setup({}, [], undefined, apps);
  const out = await done.service.verifyMobileLink({ ...req({ rollNumber: 'R-1' }), code: '123456' });
  assert.equal(done.row.mobile, MOBILE, 'one link covers the account');
  assert.equal(out.candidate.id, 'c1');
  assert.equal(out.candidate.examCount, 2);
  assert.deepEqual(done.activity.filter((a) => a.eventType === 'MOBILE_SELF_REGISTERED').map((a) => a.candidateId), ['a1']);

  const same = setup({}, [], undefined, [application('a1'), application('a2')]);
  await same.service.verifyMobileLink({ ...req(), code: '123456' });
  assert.deepEqual(same.activity.filter((a) => a.eventType === 'MOBILE_SELF_REGISTERED').map((a) => a.candidateId).sort(), ['a1', 'a2']);
});
