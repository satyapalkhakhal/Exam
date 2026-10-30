// scripts/reset-admin-password.ts
// Break-glass: sets a new password for an admin (e.g. the only Super Admin is
// locked out), clears failedLoginCount/lockedUntil and signs that admin out
// everywhere (the old password may be compromised). The password is read
// from the terminal with echo off (or from piped stdin when not a TTY), never
// from argv, so it stays out of shell history and the process list.
// Usage: pnpm --filter @exam/api admin:reset-password <email>

import { AdminUserCreateSchema } from '@exam/shared';
import { prisma } from '../infrastructure/db/prisma.js';
import { getRedis } from '../infrastructure/redis/redis.js';
import { revokeAllSessions } from '../modules/adminAuth/index.js';
import type { AuditRecord } from '../modules/audit/index.js';
import { adminUsersRepository, hashPassword as bcryptHash, type AdminUsersRepository } from '../modules/adminUsers/index.js';

export async function resetAdminPassword(
  deps: {
    repo: Pick<AdminUsersRepository, 'findByEmail' | 'update'>;
    hashPassword: (p: string) => Promise<string>;
    revokeSessions: (adminId: string) => Promise<void>;
  },
  rawEmail: string,
  password: string,
): Promise<{ id: string; email: string }> {
  const checked = AdminUserCreateSchema.shape.password.safeParse(password);
  if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? 'Invalid password');
  const email = rawEmail.trim().toLowerCase();
  const admin = await deps.repo.findByEmail(email);
  if (!admin) throw new Error('No admin with that email.');
  const entry: AuditRecord = {
    adminId: null,
    action: 'ADMIN_PASSWORD_RESET_CLI',
    entity: 'admin_user',
    entityId: admin.id,
    metadata: { via: 'cli', lockoutCleared: true },
  };
  await deps.repo.update(
    admin.id,
    { passwordHash: await deps.hashPassword(password), failedLoginCount: 0, lockedUntil: null },
    { keepAnotherSuperAdmin: false },
    entry,
  );
  await deps.revokeSessions(admin.id);
  return { id: admin.id, email: admin.email };
}

/** Reads one line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c: string) => (data += c));
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0] ?? ''));
      stdin.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) throw new Error('Usage: pnpm --filter @exam/api admin:reset-password <email>');
  const password = await promptHidden('New password: ');
  if (process.stdin.isTTY) {
    const again = await promptHidden('Repeat password: ');
    if (again !== password) throw new Error('Passwords do not match.');
  }
  const done = await resetAdminPassword(
    { repo: adminUsersRepository, hashPassword: bcryptHash, revokeSessions: (id) => revokeAllSessions('admin', id) },
    email,
    password,
  );
  console.log(`Password reset, lockout cleared and all sessions signed out for ${done.email}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err: unknown) => {
      console.error('reset-admin-password failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => Promise.all([prisma.$disconnect(), getRedis().quit()]));
}
