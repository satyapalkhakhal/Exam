// Migration 20261110120000_mcq_questions on a throw-away database built from the
// earlier migrations: it only adds columns and widens decimals, so every existing
// question and attempt stays a written one with identical marks.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg, { type Client } from 'pg';
import { env } from '../../src/infrastructure/config/env.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../prisma/migrations');
const TARGET = '20261110120000_mcq_questions';
const DB = `exam_mig_${crypto.randomBytes(4).toString('hex')}`;
const urlFor = (db: string): string => {
  const u = new URL(env.DATABASE_URL);
  u.pathname = `/${db}`;
  u.search = '';
  return u.toString();
};
const sql = (dir: string): string => fs.readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');

let admin: Client;
let db: Client;

before(async () => {
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB}`);
  db = new pg.Client({ connectionString: urlFor(DB) });
  await db.connect();
  for (const dir of fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d) && d < TARGET).sort()) await db.query(sql(dir));
});

after(async () => {
  await db?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.end();
  }
});

const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0]!;

test('mcq migration keeps existing questions and totals identical', async () => {
  const { id: roleId } = await one(`INSERT INTO job_roles (name, updated_at) VALUES ('Role', now()) RETURNING id`);
  // The colleges/drives migration always creates IIT Guwahati.
  const { id: collegeId } = await one(`SELECT id FROM colleges WHERE short_code = 'IITG'`);
  const { id: roundId } = await one(`INSERT INTO exam_rounds (job_role_id, round_number, updated_at) VALUES ($1, 1, now()) RETURNING id`, [roleId]);
  const { id: driveId } = await one(`INSERT INTO drives (round_id, college_id, batch, updated_at) VALUES ($1, $2, 'B', now()) RETURNING id`, [roundId, collegeId]);
  const { id: qId } = await one(`INSERT INTO questions (round_id, text, normalized_text_hash, max_marks, updated_at) VALUES ($1, 'Q', 'h', 10, now()) RETURNING id`, [roundId]);
  const { id: accId } = await one(`INSERT INTO candidate_accounts (email, updated_at) VALUES ('a@x.test', now()) RETURNING id`);
  const { id: candId } = await one(
    `INSERT INTO candidates (account_id, candidate_code, full_name, email, job_role_id, drive_id, updated_at) VALUES ($1, 'C1', 'A', 'a@x.test', $2, $3, now()) RETURNING id`,
    [accId, roleId, driveId],
  );
  const { id: attId } = await one(
    `INSERT INTO exam_attempts (candidate_id, status, started_at, ends_at, active_session_id, start_ip, user_agent, total_marks, max_marks, percentage, updated_at)
     VALUES ($1, 'SUBMITTED', now(), now(), 's', 'ip', 'ua', 7.5, 10, 75, now()) RETURNING id`,
    [candId],
  );
  await db.query(`INSERT INTO attempt_questions (attempt_id, question_id, "order", text_snapshot, max_marks_snapshot) VALUES ($1, $2, 1, 'Q', 10)`, [attId, qId]);

  await db.query('BEGIN');
  await db.query(sql(TARGET));
  await db.query('COMMIT');

  const q = await one(`SELECT type::text, options, correct_option FROM questions WHERE id = $1`, [qId]);
  assert.deepEqual([q.type, q.options, q.correct_option], ['WRITTEN', [], null]);
  const aq = await one(`SELECT type_snapshot::text, options_snapshot, correct_snapshot, auto_marks, negative_marks_snapshot::text FROM attempt_questions WHERE attempt_id = $1`, [attId]);
  assert.deepEqual([aq.type_snapshot, aq.options_snapshot, aq.correct_snapshot, aq.auto_marks, aq.negative_marks_snapshot], ['WRITTEN', [], null, null, '0.00']);
  const a = await one(`SELECT total_marks::text, max_marks::text, mcq_marks, mcq_max_marks::text FROM exam_attempts WHERE id = $1`, [attId]);
  assert.deepEqual([a.total_marks, a.max_marks, a.mcq_marks, a.mcq_max_marks], ['7.50', '10.00', null, '0.00']);
  assert.equal((await one(`SELECT mcq_negative_marks::text AS n FROM exam_rounds WHERE id = $1`, [roundId])).n, '0.00');
  // Quarter marks are now exact.
  await db.query(`UPDATE exam_attempts SET total_marks = 7.25 WHERE id = $1`, [attId]);
  assert.equal((await one(`SELECT total_marks::text AS t FROM exam_attempts WHERE id = $1`, [attId])).t, '7.25');
});
