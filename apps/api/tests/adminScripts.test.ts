import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { disableIntegrations } from '../src/scripts/disable-integrations.js';
import { resetAdminPassword } from '../src/scripts/reset-admin-password.js';
import type { AuditRecord } from '../src/modules/audit/index.js';
import type { AdminUserChanges, AdminUserRow } from '../src/modules/adminUsers/adminUsers.service.js';

test('disable-integrations flips enabled:false on both keys and keeps the sealed secrets untouched', async () => {
  const rows = new Map<string, unknown>([
    ['sms.arihant', { enabled: true, baseUrl: 'https://s', authToken: 'v1:sealed-a', apiKey: 'v1:sealed-b' }],
    ['email.zatpatmail', { enabled: true, baseUrl: 'https://e', sendMailToken: 'v1:sealed-c' }],
  ]);
  const writes: { key: string; adminId: string | null }[] = [];
  const audits: AuditRecord[] = [];
  const keys = await disableIntegrations({
    config: {
      findByKey: async (key) => (rows.has(key) ? { key, value: rows.get(key) } : null),
      upsert: async (key, value, adminId) => {
        rows.set(key, value);
        writes.push({ key, adminId });
      },
    },
    audit: async (e) => {
      audits.push(e);
    },
  });
  assert.deepEqual(keys.sort(), ['email.zatpatmail', 'sms.arihant']);
  assert.deepEqual(rows.get('sms.arihant'), { enabled: false, baseUrl: 'https://s', authToken: 'v1:sealed-a', apiKey: 'v1:sealed-b' });
  assert.deepEqual(rows.get('email.zatpatmail'), { enabled: false, baseUrl: 'https://e', sendMailToken: 'v1:sealed-c' });
  assert.ok(writes.every((w) => w.adminId === null));
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.adminId, null);
  assert.equal(audits[0]!.action, 'INTEGRATIONS_DISABLED_CLI');
});

test('disable-integrations writes a disabled row when a key is missing entirely', async () => {
  const rows = new Map<string, unknown>();
  await disableIntegrations({
    config: {
      findByKey: async () => null,
      upsert: async (key, value) => {
        rows.set(key, value);
      },
    },
    audit: async () => {},
  });
  assert.deepEqual(rows.get('sms.arihant'), { enabled: false });
  assert.deepEqual(rows.get('email.zatpatmail'), { enabled: false });
});

function fakeAdmins() {
  const row: AdminUserRow & { passwordHash: string; failedLoginCount: number } = {
    id: 'a1',
    name: 'A',
    email: 'admin@x.test',
    role: 'SUPER_ADMIN',
    active: true,
    lastLoginAt: null,
    lockedUntil: new Date(Date.now() + 600_000),
    createdAt: new Date(),
    passwordHash: 'old',
    failedLoginCount: 3,
  };
  const audits: AuditRecord[] = [];
  return {
    row,
    audits,
    repo: {
      findByEmail: async (email: string) => (email === row.email ? { ...row } : null),
      update: async (_id: string, data: AdminUserChanges, _opts: { keepAnotherSuperAdmin: boolean }, audit: AuditRecord) => {
        Object.assign(row, data);
        audits.push(audit);
        return { ...row };
      },
    },
  };
}

test('reset-password sets a new bcrypt hash, clears the lockout and audits without the password', async () => {
  const f = fakeAdmins();
  const revoked: string[] = [];
  await resetAdminPassword(
    { repo: f.repo, hashPassword: (p) => bcrypt.hash(p, 4), revokeSessions: async (id) => void revoked.push(id) },
    '  Admin@X.test ',
    'brand-new-pass',
  );
  assert.deepEqual(revoked, ['a1'], 'all sessions of the admin are revoked');
  assert.ok(await bcrypt.compare('brand-new-pass', f.row.passwordHash));
  assert.equal(f.row.failedLoginCount, 0);
  assert.equal(f.row.lockedUntil, null);
  assert.equal(f.audits[0]!.adminId, null);
  assert.equal(f.audits[0]!.action, 'ADMIN_PASSWORD_RESET_CLI');
  assert.ok(!JSON.stringify(f.audits).includes('brand-new-pass'));
});

test('reset-password rejects a short password and an unknown email', async () => {
  const f = fakeAdmins();
  const deps = { repo: f.repo, hashPassword: (p: string) => bcrypt.hash(p, 4), revokeSessions: async () => {} };
  await assert.rejects(resetAdminPassword(deps, 'admin@x.test', 'short'), /at least 8/);
  await assert.rejects(resetAdminPassword(deps, 'ghost@x.test', 'long-enough-1'), /No admin/);
  assert.equal(f.row.passwordHash, 'old');
});
