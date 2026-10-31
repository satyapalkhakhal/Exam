import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Prisma } from '../src/generated/prisma/client.js';
import { backfillNewRound, grantNextRound, revokeNextRound } from '../src/modules/rounds/qualification.js';

// In-memory transaction client: one exam with rounds 1 and 2, one person with
// a round-1 entry. Records raw-lock queries so lock usage can be asserted.
function fakeTx(opts: { rounds?: number; attemptsOnNext?: number } = {}) {
  const rounds = opts.rounds ?? 2;
  const entries = new Map<string, { id: string; registrationId: string; roundId: string }>();
  entries.set('e1', { id: 'e1', registrationId: 'reg1', roundId: 'r1' });
  const history: Record<string, unknown>[] = [];
  const locks: string[] = [];
  let seq = 1;
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      locks.push(sql);
      if (sql.includes('JOIN exam_rounds')) {
        return [{ id: 'e1', registration_id: 'reg1', candidate_id: 'c1', exam_id: 'x1', round_number: 1 }];
      }
      if (sql.includes("status = 'SHORTLISTED'")) return [{ registration_id: 'reg1', candidate_id: 'c1' }];
      return [];
    },
    examRound: {
      findFirst: async (a: { where: { roundNumber: { gt?: number; lt?: number } } }) =>
        a.where.roundNumber.gt !== undefined
          ? rounds >= 2
            ? { id: 'r2' }
            : null
          : { id: 'r1' },
      findUnique: async () => ({ examId: 'x1', roundNumber: 2 }),
    },
    roundEntry: {
      findUnique: async (a: { where: { registrationId_roundId: { roundId: string } } }) =>
        [...entries.values()].find((e) => e.roundId === a.where.registrationId_roundId.roundId) ?? null,
      create: async (a: { data: { registrationId: string; roundId: string } }) => {
        const id = `n${seq++}`;
        entries.set(id, { id, ...a.data });
        return { id };
      },
      delete: async (a: { where: { id: string } }) => {
        entries.delete(a.where.id);
      },
    },
    candidateStatusHistory: {
      create: async (a: { data: Record<string, unknown> }) => {
        history.push(a.data);
      },
      deleteMany: async (a: { where: { roundEntryId: string } }) => {
        for (let i = history.length - 1; i >= 0; i--) if (history[i]?.roundEntryId === a.where.roundEntryId) history.splice(i, 1);
      },
    },
    examAttempt: { count: async () => opts.attemptsOnNext ?? 0 },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, entries, history, locks };
}

test('grant creates next entry', async () => {
  const f = fakeTx();
  const id = await grantNextRound(f.tx, 'e1', 'admin1');
  assert.ok(id);
  assert.equal(f.entries.get(id)?.roundId, 'r2');
  assert.equal(f.entries.get(id)?.registrationId, 'reg1');
  assert.deepEqual(f.history, [
    { candidateId: 'c1', roundEntryId: id, fromStatus: null, toStatus: 'NOT_STARTED', byAdminId: 'admin1' },
  ]);
  assert.ok(f.locks.some((l) => l.includes('FOR SHARE')));
  assert.ok(f.locks.some((l) => l.includes('FOR UPDATE')));
});

test('grant is idempotent', async () => {
  const f = fakeTx();
  const a = await grantNextRound(f.tx, 'e1', 'admin1');
  const b = await grantNextRound(f.tx, 'e1', 'admin1');
  assert.equal(a, b);
  assert.equal(f.entries.size, 2);
  assert.equal(f.history.length, 1);
});

test('grant on last round returns null', async () => {
  const f = fakeTx({ rounds: 1 });
  assert.equal(await grantNextRound(f.tx, 'e1', 'admin1'), null);
  assert.equal(f.entries.size, 1);
});

test('revoke removes untouched next entry and its history', async () => {
  const f = fakeTx();
  await grantNextRound(f.tx, 'e1', 'admin1');
  assert.equal(await revokeNextRound(f.tx, 'e1'), 'removed');
  assert.equal(f.entries.size, 1);
  assert.equal(f.history.length, 0);
  assert.equal(await revokeNextRound(f.tx, 'e1'), 'none');
});

test('revoke refuses after start', async () => {
  const f = fakeTx({ attemptsOnNext: 1 });
  await grantNextRound(f.tx, 'e1', 'admin1');
  await assert.rejects(revokeNextRound(f.tx, 'e1'), (e: { statusCode?: number; message?: string }) => {
    assert.equal(e.statusCode, 409);
    assert.equal(e.message, 'The candidate has already started the next round.');
    return true;
  });
  assert.equal(f.entries.size, 2);
});

test('backfill gives each shortlisted person an entry in the new round', async () => {
  const f = fakeTx();
  assert.equal(await backfillNewRound(f.tx, 'r2', 'admin1'), 1);
  assert.equal(f.history.length, 1);
});
