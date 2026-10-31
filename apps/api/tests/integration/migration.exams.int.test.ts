// The 20261101120000_exams_rounds_registrations migration, checked on old-shape
// data: a throwaway database (exam_migtest, on the same server as exam_test) is
// built from the earlier migrations, filled with pre-migration rows by raw SQL,
// then migrated. exam_test and exam_db are never touched; exam_migtest is
// dropped afterwards.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';

const NEW_MIGRATION = '20261101120000_exams_rounds_registrations';
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'prisma/migrations');

const testUrl = dotenv.parse(fs.readFileSync(path.resolve(process.cwd(), '.env.test')))['DATABASE_URL'] ?? '';
const migUrl = (() => {
  const u = new URL(testUrl);
  u.pathname = '/exam_migtest';
  return u.toString();
})();

// Fixed ids so assertions can name rows.
const ADMIN = '00000000-0000-4000-8000-000000000001';
const ROLE_A = '00000000-0000-4000-8000-0000000000a1';
const ROLE_B = '00000000-0000-4000-8000-0000000000b1';
const ROLE_C = '00000000-0000-4000-8000-0000000000c1'; // no exam_settings row
const BATCH = '00000000-0000-4000-8000-000000000101';
const CAND_EVALUATED = '00000000-0000-4000-8000-000000000201';
const CAND_RESET = '00000000-0000-4000-8000-000000000202';
const CAND_B = '00000000-0000-4000-8000-000000000203';
const ATT_EVALUATED = '00000000-0000-4000-8000-000000000301';
const ATT_RESET = '00000000-0000-4000-8000-000000000302';
const ATT_SUBMITTED = '00000000-0000-4000-8000-000000000303';
const WINDOW_START = '2026-11-10T04:30:00.000Z';
const WINDOW_END = '2026-11-10T08:30:00.000Z';

let admin: InstanceType<typeof pg.Client>; // connected to exam_test's server, used only to create/drop exam_migtest
let db: InstanceType<typeof pg.Client>; // connected to exam_migtest

function migrationSql(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
}

const OLD_SHAPE_FIXTURES = `
INSERT INTO admin_users (id, email, password_hash, name, role, updated_at)
  VALUES ('${ADMIN}', 'sa@mig.test', 'x', 'Mig Super', 'SUPER_ADMIN', now());

INSERT INTO job_roles (id, name, updated_at) VALUES
  ('${ROLE_A}', 'Backend Developer', now()),
  ('${ROLE_B}', 'Data Analyst', now()),
  ('${ROLE_C}', 'Designer', now());

INSERT INTO exam_settings (job_role_id, duration_minutes, window_start, window_end, instructions, is_open, questions_locked, updated_at) VALUES
  ('${ROLE_A}', 45, '${WINDOW_START}', '${WINDOW_END}', 'x', true, true, now()),
  ('${ROLE_B}', 45, '${WINDOW_START}', '${WINDOW_END}', 'x', true, true, now());

-- Same normalized hash under two profiles was legal before and must stay legal.
INSERT INTO questions (job_role_id, text, normalized_text_hash, max_marks, updated_at) VALUES
  ('${ROLE_A}', 'Q1', 'h1', 10, now()),
  ('${ROLE_A}', 'Q2', 'h2', 10, now()),
  ('${ROLE_B}', 'Q1', 'h1', 10, now());

INSERT INTO import_batches (id, kind, job_role_id, file_name, file_hash, uploaded_by_id)
  VALUES ('${BATCH}', 'CANDIDATES', '${ROLE_A}', 'c.csv', 'fh', '${ADMIN}');

INSERT INTO candidates (id, candidate_code, full_name, email, job_role_id, status, import_batch_id, updated_at) VALUES
  ('${CAND_EVALUATED}', 'ARH-EX-000001', 'Eva', 'eva@mig.test', '${ROLE_A}', 'EVALUATED', '${BATCH}', now()),
  ('${CAND_RESET}', 'ARH-EX-000002', 'Ravi', 'ravi@mig.test', '${ROLE_A}', 'SUBMITTED', NULL, now()),
  ('${CAND_B}', 'ARH-EX-000003', 'Bina', 'bina@mig.test', '${ROLE_B}', 'NOT_STARTED', NULL, now());

INSERT INTO exam_attempts (id, candidate_id, status, started_at, ends_at, active_session_id, start_ip, user_agent, max_marks, updated_at) VALUES
  ('${ATT_EVALUATED}', '${CAND_EVALUATED}', 'SUBMITTED', now(), now(), 's', '1.1.1.1', 'ua', 20, now()),
  ('${ATT_RESET}', '${CAND_RESET}', 'RESET', now(), now(), 's', '1.1.1.1', 'ua', 20, now()),
  ('${ATT_SUBMITTED}', '${CAND_RESET}', 'SUBMITTED', now(), now(), 's', '1.1.1.1', 'ua', 20, now());

INSERT INTO candidate_status_history (candidate_id, from_status, to_status, by_admin_id) VALUES
  ('${CAND_EVALUATED}', 'SUBMITTED', 'EVALUATED', '${ADMIN}'),
  ('${CAND_RESET}', 'IN_PROGRESS', 'NOT_STARTED', '${ADMIN}'),
  ('${CAND_RESET}', 'IN_PROGRESS', 'SUBMITTED', NULL);
`;

before(async () => {
  // Never point this at anything but the local test server's throwaway db.
  assert.match(testUrl, /\/exam_test(\?|$)/);
  assert.match(migUrl, /\/exam_migtest(\?|$)/);

  admin = new pg.Client({ connectionString: testUrl });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS exam_migtest WITH (FORCE)');
  await admin.query('CREATE DATABASE exam_migtest');

  db = new pg.Client({ connectionString: migUrl });
  await db.connect();
  const earlier = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((d) => /^\d{14}_/.test(d) && d < NEW_MIGRATION)
    .sort();
  assert.equal(earlier.length, 4);
  for (const name of earlier) await db.query(migrationSql(name));

  await db.query(OLD_SHAPE_FIXTURES);
  // A simple-protocol multi-statement query runs as one implicit transaction,
  // as prisma migrate deploy does.
  await db.query(migrationSql(NEW_MIGRATION));
});

after(async () => {
  await db?.end();
  if (admin) {
    await admin.query('DROP DATABASE IF EXISTS exam_migtest WITH (FORCE)');
    await admin.end();
  }
});

async function entryOf(candidateId: string): Promise<{ id: string; status: string; round_id: string }> {
  const { rows } = await db.query(
    `SELECT re.id, re.status::text AS status, re.round_id
       FROM round_entries re JOIN exam_registrations reg ON reg.id = re.registration_id
      WHERE reg.candidate_id = $1`,
    [candidateId],
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

async function round1Of(roleId: string): Promise<string> {
  const { rows } = await db.query(
    `SELECT r.id FROM exam_rounds r JOIN exams e ON e.id = r.exam_id
      WHERE e.job_role_id = $1 AND r.round_number = 1`,
    [roleId],
  );
  assert.equal(rows.length, 1);
  return rows[0].id;
}

test('backfill creates one exam and Round 1 per job profile', async () => {
  const exams = await db.query(
    `SELECT e.job_role_id, e.name, e.active, j.name AS role_name
       FROM exams e JOIN job_roles j ON j.id = e.job_role_id ORDER BY e.name`,
  );
  assert.equal(exams.rows.length, 3);
  for (const e of exams.rows) {
    assert.equal(e.name, e.role_name);
    assert.equal(e.active, true);
  }
  assert.deepEqual(
    exams.rows.map((e) => e.name),
    ['Backend Developer', 'Data Analyst', 'Designer'],
  );

  for (const role of [ROLE_A, ROLE_B]) {
    const { rows } = await db.query(
      `SELECT r.round_number, r.name, r.duration_minutes, r.window_start, r.window_end, r.instructions,
              r.is_open, r.questions_locked
         FROM exam_rounds r JOIN exams e ON e.id = r.exam_id WHERE e.job_role_id = $1`,
      [role],
    );
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.round_number, 1);
    assert.equal(r.name, null);
    assert.equal(r.duration_minutes, 45);
    assert.equal(new Date(r.window_start).toISOString(), WINDOW_START);
    assert.equal(new Date(r.window_end).toISOString(), WINDOW_END);
    assert.equal(r.instructions, 'x');
    assert.equal(r.is_open, true);
    assert.equal(r.questions_locked, true);
  }
});

test('a job profile without exam_settings gets a Round 1 with default settings', async () => {
  const { rows } = await db.query(
    `SELECT r.round_number, r.duration_minutes, r.window_start, r.window_end, r.instructions, r.is_open, r.questions_locked
       FROM exam_rounds r JOIN exams e ON e.id = r.exam_id WHERE e.job_role_id = $1`,
    [ROLE_C],
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    round_number: 1,
    duration_minutes: 60,
    window_start: null,
    window_end: null,
    instructions: '',
    is_open: false,
    questions_locked: false,
  });
});

test('backfill moves questions to Round 1', async () => {
  const a1 = await round1Of(ROLE_A);
  const b1 = await round1Of(ROLE_B);
  const { rows } = await db.query('SELECT job_role_id, round_id FROM questions');
  assert.equal(rows.length, 3);
  for (const q of rows) assert.equal(q.round_id, q.job_role_id === ROLE_A ? a1 : b1);
});

test('backfill registers each candidate once with their status', async () => {
  const regs = await db.query(
    `SELECT reg.candidate_id, reg.import_batch_id, e.job_role_id
       FROM exam_registrations reg JOIN exams e ON e.id = reg.exam_id`,
  );
  assert.equal(regs.rows.length, 3);
  const evaReg = regs.rows.find((r) => r.candidate_id === CAND_EVALUATED);
  assert.equal(evaReg.import_batch_id, BATCH);
  assert.equal(evaReg.job_role_id, ROLE_A);
  assert.equal(regs.rows.find((r) => r.candidate_id === CAND_B).job_role_id, ROLE_B);

  assert.equal((await db.query('SELECT 1 FROM round_entries')).rows.length, 3);
  const eva = await entryOf(CAND_EVALUATED);
  assert.equal(eva.status, 'EVALUATED');
  assert.equal(eva.round_id, await round1Of(ROLE_A));
  assert.equal((await entryOf(CAND_B)).status, 'NOT_STARTED');
});

test('backfill keeps reset attempts', async () => {
  const entry = await entryOf(CAND_RESET);
  const attempts = await db.query(
    'SELECT id, status::text AS status, round_entry_id FROM exam_attempts WHERE candidate_id = $1 ORDER BY id',
    [CAND_RESET],
  );
  assert.deepEqual(
    attempts.rows.map((a) => [a.id, a.status, a.round_entry_id]),
    [
      [ATT_RESET, 'RESET', entry.id],
      [ATT_SUBMITTED, 'SUBMITTED', entry.id],
    ],
  );
  const history = await db.query('SELECT round_entry_id FROM candidate_status_history WHERE candidate_id = $1', [
    CAND_RESET,
  ]);
  assert.equal(history.rows.length, 2);
  for (const h of history.rows) assert.equal(h.round_entry_id, entry.id);

  const eva = await entryOf(CAND_EVALUATED);
  const evaAttempt = await db.query('SELECT round_entry_id FROM exam_attempts WHERE id = $1', [ATT_EVALUATED]);
  assert.equal(evaAttempt.rows[0].round_entry_id, eva.id);
  // Nothing left unlinked; the link columns are now mandatory.
  for (const table of ['exam_attempts', 'candidate_status_history']) {
    const nulls = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE round_entry_id IS NULL`);
    assert.equal(nulls.rows[0].n, 0);
  }
});

test('link columns are NOT NULL; old job_role_id columns become nullable and stay', async () => {
  const { rows } = await db.query(
    `SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND (
        (table_name IN ('exam_attempts', 'candidate_status_history') AND column_name = 'round_entry_id')
        OR (table_name = 'questions' AND column_name IN ('round_id', 'job_role_id'))
        OR (table_name = 'candidates' AND column_name IN ('job_role_id', 'status'))
        OR (table_name = 'import_batches' AND column_name = 'exam_id'))
      ORDER BY table_name, column_name`,
  );
  assert.deepEqual(
    rows.map((r) => `${r.table_name}.${r.column_name}=${r.is_nullable}`),
    [
      'candidate_status_history.round_entry_id=NO',
      'candidates.job_role_id=YES',
      'candidates.status=NO',
      'exam_attempts.round_entry_id=NO',
      'import_batches.exam_id=YES',
      'questions.job_role_id=YES',
      'questions.round_id=NO',
    ],
  );
  const settings = await db.query('SELECT count(*)::int AS n FROM exam_settings');
  assert.equal(settings.rows[0].n, 2);
});

test('new indexes enforce rules', async () => {
  const insertAttempt = (id: string, candidateId: string, entryId: string, status: string) =>
    db.query(
      `INSERT INTO exam_attempts (id, candidate_id, round_entry_id, status, started_at, ends_at, active_session_id,
                                  start_ip, user_agent, max_marks, updated_at)
       VALUES ($1, $2, $3, $4::"AttemptStatus", now(), now(), 's', '1.1.1.1', 'ua', 20, now())`,
      [id, candidateId, entryId, status],
    );
  const uniqueViolation = (index: string) => (err: unknown) => {
    const e = err as { code?: string; constraint?: string };
    assert.equal(e.code, '23505');
    assert.equal(e.constraint, index);
    return true;
  };

  // One live attempt per round entry: a second non-RESET one is refused, a RESET one is fine.
  const evaEntry = await entryOf(CAND_EVALUATED);
  await assert.rejects(
    insertAttempt('00000000-0000-4000-8000-000000000401', CAND_EVALUATED, evaEntry.id, 'SUBMITTED'),
    uniqueViolation('uq_exam_attempts_entry_live'),
  );
  await insertAttempt('00000000-0000-4000-8000-000000000402', CAND_EVALUATED, evaEntry.id, 'RESET');

  // One exam at a time: Bina gets a second exam; an IN_PROGRESS attempt on each is refused.
  const bEntry = await entryOf(CAND_B);
  const second = await db.query(
    `WITH e AS (INSERT INTO exams (job_role_id, name, updated_at) VALUES ($1, 'Data Analyst – Dec 2026', now()) RETURNING id),
          r AS (INSERT INTO exam_rounds (exam_id, round_number, updated_at) SELECT id, 1, now() FROM e RETURNING id),
          g AS (INSERT INTO exam_registrations (candidate_id, exam_id) SELECT $2, id FROM e RETURNING id)
     INSERT INTO round_entries (registration_id, round_id, updated_at) SELECT g.id, r.id, now() FROM g, r RETURNING id`,
    [ROLE_B, CAND_B],
  );
  await insertAttempt('00000000-0000-4000-8000-000000000403', CAND_B, bEntry.id, 'IN_PROGRESS');
  await assert.rejects(
    insertAttempt('00000000-0000-4000-8000-000000000404', CAND_B, second.rows[0].id, 'IN_PROGRESS'),
    uniqueViolation('uq_exam_attempts_candidate_in_progress'),
  );

  // The old one-attempt-per-candidate index is gone: a submitted attempt on the other exam is allowed.
  await insertAttempt('00000000-0000-4000-8000-000000000405', CAND_B, second.rows[0].id, 'SUBMITTED');
  const old = await db.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_exam_attempts_candidate_active'`);
  assert.equal(old.rows.length, 0);

  // Exam names are unique across all exams.
  await assert.rejects(
    db.query(`INSERT INTO exams (job_role_id, name, updated_at) VALUES ($1, 'Backend Developer', now())`, [ROLE_B]),
    uniqueViolation('exams_name_key'),
  );

  // The same question text may sit in two rounds of one profile, but not twice in one round.
  const a1 = await round1Of(ROLE_A);
  await assert.rejects(
    db.query(
      `INSERT INTO questions (job_role_id, round_id, text, normalized_text_hash, max_marks, updated_at)
       VALUES ($1, $2, 'Q1 again', 'h1', 10, now())`,
      [ROLE_A, a1],
    ),
    uniqueViolation('questions_round_id_normalized_text_hash_key'),
  );
  const a2 = await db.query(
    `INSERT INTO exam_rounds (exam_id, round_number, updated_at)
     SELECT exam_id, 2, now() FROM exam_rounds WHERE id = $1 RETURNING id`,
    [a1],
  );
  await db.query(
    `INSERT INTO questions (job_role_id, round_id, text, normalized_text_hash, max_marks, updated_at)
     VALUES ($1, $2, 'Q1', 'h1', 10, now())`,
    [ROLE_A, a2.rows[0].id],
  );
});
