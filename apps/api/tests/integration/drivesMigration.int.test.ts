// Migration 20261110090000_colleges_drives_rounds against real old-shape data.
// The test builds a throw-away database next to exam_test, applies every
// earlier migration, inserts rows the way the pre-drives app wrote them, then
// runs the new migration file exactly as it ships and checks the mapping:
// every job role -> Round 1 -> one IITG drive (batch "Nov 2026").

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg, { type Client } from 'pg';
import { env } from '../../src/infrastructure/config/env.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../prisma/migrations');
const TARGET = '20261110090000_colleges_drives_rounds';
const DB = `exam_mig_${crypto.randomBytes(4).toString('hex')}`;

const urlFor = (db: string): string => {
  const u = new URL(env.DATABASE_URL);
  u.pathname = `/${db}`;
  u.search = '';
  return u.toString();
};
const migrationSql = (dir: string): string => fs.readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');

let admin: Client;
let db: Client;

before(async () => {
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB}`);
  db = new pg.Client({ connectionString: urlFor(DB) });
  await db.connect();
  const earlier = fs
    .readdirSync(MIGRATIONS)
    .filter((d) => /^\d{14}_/.test(d) && d < TARGET)
    .sort();
  for (const dir of earlier) await db.query(migrationSql(dir));
});

after(async () => {
  await db?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.end();
  }
});

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> =>
  (await db.query(sql, params)).rows[0] as T;

test('migration maps every row to round 1 × IITG', async () => {
  // --- old-shape data -------------------------------------------------------
  const { id: adminId } = await one<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, name, role, updated_at) VALUES ('a@x.test','x','A','SUPER_ADMIN',now()) RETURNING id`,
  );
  const { id: roleA } = await one<{ id: string }>(`INSERT INTO job_roles (name, updated_at) VALUES ('Quant Analyst', now()) RETURNING id`);
  const { id: roleB } = await one<{ id: string }>(`INSERT INTO job_roles (name, updated_at) VALUES ('Bare Role', now()) RETURNING id`);
  await db.query(
    `INSERT INTO exam_settings (job_role_id, duration_minutes, window_start, window_end, instructions, is_open, questions_locked,
       weight_exam, weight_x, weight_xii, weight_cpi, updated_at)
     VALUES ($1, 90, '2026-11-03T04:00:00Z', '2026-11-03T10:00:00Z', 'Read carefully.', true, true, 60, 20, 10, 10, now())`,
    [roleA],
  );
  // roleB deliberately has no exam_settings row.
  const { id: qBatch } = await one<{ id: string }>(
    `INSERT INTO import_batches (kind, job_role_id, file_name, file_hash, uploaded_by_id) VALUES ('QUESTIONS', $1, 'q.csv', 'h1', $2) RETURNING id`,
    [roleA, adminId],
  );
  const { id: cBatch } = await one<{ id: string }>(
    `INSERT INTO import_batches (kind, job_role_id, file_name, file_hash, uploaded_by_id) VALUES ('CANDIDATES', $1, 'c.csv', 'h2', $2) RETURNING id`,
    [roleA, adminId],
  );
  for (const [i, role] of [roleA, roleA, roleB].entries()) {
    await db.query(
      `INSERT INTO questions (job_role_id, text, normalized_text_hash, max_marks, display_order, updated_at) VALUES ($1, $2, $3, 10, $4, now())`,
      [role, `Q${i}`, `hash${i}`, i],
    );
  }
  const people = [
    { email: 'p1@x.test', role: roleA },
    { email: 'p2@x.test', role: roleA },
    { email: 'p3@x.test', role: roleB },
  ];
  for (const [i, p] of people.entries()) {
    const { id: acc } = await one<{ id: string }>(`INSERT INTO candidate_accounts (email, updated_at) VALUES ($1, now()) RETURNING id`, [p.email]);
    await db.query(
      `INSERT INTO candidates (account_id, candidate_code, full_name, email, job_role_id, import_batch_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [acc, `C${i}`, `P${i}`, p.email, p.role, p.role === roleA ? cBatch : null],
    );
  }
  // Same person (p1) also applied to roleB: the old (account, role) rule allowed it.
  const { id: p1Acc } = await one<{ id: string }>(`SELECT id FROM candidate_accounts WHERE email = 'p1@x.test'`);
  await db.query(
    `INSERT INTO candidates (account_id, candidate_code, full_name, email, job_role_id, updated_at) VALUES ($1, 'C9', 'P1', 'p1@x.test', $2, now())`,
    [p1Acc, roleB],
  );
  const { id: runRole } = await one<{ id: string }>(
    `INSERT INTO ai_evaluation_runs (job_role_id, model, prompt_version, created_by_id) VALUES ($1, 'm', 'v1', $2) RETURNING id`,
    [roleA, adminId],
  );
  const { id: runSel } = await one<{ id: string }>(
    `INSERT INTO ai_evaluation_runs (job_role_id, model, prompt_version, created_by_id) VALUES (NULL, 'm', 'v1', $1) RETURNING id`,
    [adminId],
  );

  // --- the migration as shipped --------------------------------------------
  await db.query('BEGIN');
  await db.query(migrationSql(TARGET));
  await db.query('COMMIT');

  // --- college ---------------------------------------------------------------
  const colleges = (await db.query(`SELECT id, name, short_code FROM colleges`)).rows;
  assert.deepEqual(colleges.map((c) => [c.name, c.short_code]), [['IIT Guwahati', 'IITG']]);
  const iitg = colleges[0]!.id as string;

  // --- rounds: settings moved, defaults for the bare role ------------------
  const rounds = (await db.query(
    `SELECT job_role_id, round_number, duration_minutes, questions_locked, weight_exam, weight_x, weight_xii, weight_cpi, id FROM exam_rounds`,
  )).rows;
  assert.equal(rounds.length, 2);
  const rA = rounds.find((r) => r.job_role_id === roleA)!;
  const rB = rounds.find((r) => r.job_role_id === roleB)!;
  assert.deepEqual(
    [rA.round_number, rA.duration_minutes, rA.questions_locked, rA.weight_exam, rA.weight_x, rA.weight_xii, rA.weight_cpi],
    [1, 90, true, 60, 20, 10, 10],
  );
  assert.deepEqual(
    [rB.round_number, rB.duration_minutes, rB.questions_locked, rB.weight_exam, rB.weight_x, rB.weight_xii, rB.weight_cpi],
    [1, 60, false, 70, 10, 10, 10],
  );

  // --- drives: window/open/instructions moved -------------------------------
  const drives = (await db.query(`SELECT id, round_id, college_id, batch, window_start, window_end, is_open, instructions FROM drives`)).rows;
  assert.equal(drives.length, 2);
  const dA = drives.find((d) => d.round_id === rA.id)!;
  const dB = drives.find((d) => d.round_id === rB.id)!;
  assert.equal(dA.college_id, iitg);
  assert.equal(dA.batch, 'Nov 2026');
  assert.equal((dA.window_start as Date).toISOString(), '2026-11-03T04:00:00.000Z');
  assert.equal((dA.window_end as Date).toISOString(), '2026-11-03T10:00:00.000Z');
  assert.deepEqual([dA.is_open, dA.instructions], [true, 'Read carefully.']);
  assert.deepEqual([dB.college_id, dB.batch, dB.window_start, dB.is_open, dB.instructions], [iitg, 'Nov 2026', null, false, '']);

  // --- rows re-pointed ------------------------------------------------------
  const qs = (await db.query(`SELECT text, round_id FROM questions ORDER BY text`)).rows;
  assert.deepEqual(qs.map((q) => [q.text, q.round_id]), [['Q0', rA.id], ['Q1', rA.id], ['Q2', rB.id]]);

  const cands = (await db.query(`SELECT candidate_code, job_role_id, drive_id FROM candidates ORDER BY candidate_code`)).rows;
  assert.equal(cands.length, 4);
  for (const c of cands) assert.equal(c.drive_id, c.job_role_id === roleA ? dA.id : dB.id, `candidate ${c.candidate_code}`);

  const batches = (await db.query(`SELECT id, round_id, drive_id FROM import_batches`)).rows;
  assert.deepEqual(batches.find((b) => b.id === qBatch), { id: qBatch, round_id: rA.id, drive_id: null });
  assert.deepEqual(batches.find((b) => b.id === cBatch), { id: cBatch, round_id: null, drive_id: dA.id });

  const runs = (await db.query(`SELECT id, drive_id FROM ai_evaluation_runs`)).rows;
  assert.equal(runs.find((r) => r.id === runRole)!.drive_id, dA.id);
  assert.equal(runs.find((r) => r.id === runSel)!.drive_id, null);

  // --- old structure gone, new rules enforced --------------------------------
  assert.equal((await one<{ t: string | null }>(`SELECT to_regclass('exam_settings') AS t`)).t, null);
  await db.query(`INSERT INTO job_roles (name, type, updated_at) VALUES ('Quant Analyst', 'INTERNSHIP', now())`);
  await assert.rejects(db.query(`INSERT INTO job_roles (name, type, updated_at) VALUES ('quant analyst', 'PLACEMENT', now())`), /job_roles_name_type_key/);
  await assert.rejects(
    db.query(`INSERT INTO drives (round_id, college_id, batch, updated_at) VALUES ($1, $2, 'NOV 2026', now())`, [rA.id, iitg]),
    /drives_round_college_batch_key/,
  );
  await assert.rejects(db.query(`INSERT INTO colleges (name, short_code, updated_at) VALUES ('iit guwahati', 'X', now())`), /colleges_name_key/);
});
