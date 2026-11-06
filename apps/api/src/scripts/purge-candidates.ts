// scripts/purge-candidates.ts
// Retention step from deployment §10: anonymises the personal fields of every
// finished candidate created before a cut-off date, and keeps what the
// shortlisting record needs (candidateCode, status, answers and marks). A candidate
// account (the sign-in identity shared by a person's applications) is anonymised
// once every one of its applications has been. Login logs lose their
// coordinates, IP and user agent, activity logs their IP and user agent, and
// email dispatches (docs/email-templates.md) their address and rendered
// content (rows stay; the purge is the only writer besides the app's inserts),
// and AI scores (docs/ai-evaluation.md) their rationale, strengths and
// improvements text (marks, confidence and concerns stay for the record).
// It is a dry run unless
// --yes is passed, and it writes one audit row when it applies.
// Usage: pnpm --filter @exam/api purge-candidates --before 2027-04-30 [--yes]

import { prisma } from '../infrastructure/db/prisma.js';

export interface PurgeableCandidate {
  id: string;
  candidateCode: string;
  fullName: string;
  email: string;
  mobile: string | null;
  rollNumber: string | null;
  xPercentage: unknown;
  xiiPercentage: unknown;
  majorCpi: unknown;
  discipline: string | null;
  programme: string | null;
  extra: unknown;
  status: string;
}

/** Returns the anonymised copy of a candidate row: PII and academics cleared, code and status kept. */
export function anonymizeCandidate<T extends PurgeableCandidate>(row: T): T {
  return {
    ...row,
    fullName: 'Anonymised',
    email: `anon+${row.id}@invalid`,
    mobile: null,
    rollNumber: null,
    xPercentage: null,
    xiiPercentage: null,
    majorCpi: null,
    discipline: null,
    programme: null,
    extra: {},
  };
}

/** The anonymised sign-in identity of a candidate account: no email, no mobile. */
export function anonymizeAccount(id: string): { email: string; mobile: null } {
  return { email: `anon+${id}@invalid`, mobile: null };
}

const IP_PLACEHOLDER = '0.0.0.0';

/** Update payloads that strip location, IP and device data from a purged candidate's log rows. */
export const LOG_SCRUB = {
  loginLog: { latitude: null, longitude: null, accuracyM: null, ip: IP_PLACEHOLDER, userAgent: '' },
  activityLog: { ip: IP_PLACEHOLDER, userAgent: null },
} as const;

/** Update payload for a purged candidate's email dispatches: address and rendered content go, the record stays. */
export const EMAIL_DISPATCH_SCRUB = (candidateId: string) =>
  ({ toEmail: `anon+${candidateId}@invalid`, subject: 'Anonymised', html: '', text: '' }) as const;

/** Update payload for a purged candidate's AI scores: the free text derived from their answers goes. */
export const AI_SCORE_SCRUB = { rationale: null, strengths: [], improvements: [] } as const;

export function parsePurgeArgs(argv: string[]): { before: Date; apply: boolean } {
  const i = argv.indexOf('--before');
  const raw = i >= 0 ? argv[i + 1] : undefined;
  const before = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : null;
  if (!before || Number.isNaN(before.getTime())) throw new Error('Usage: purge-candidates --before YYYY-MM-DD [--yes]');
  return { before, apply: argv.includes('--yes') };
}

async function main(): Promise<void> {
  const { before, apply } = parsePurgeArgs(process.argv.slice(2));
  const where = { createdAt: { lt: before }, status: { not: 'IN_PROGRESS' as const }, fullName: { not: 'Anonymised' } };
  const total = await prisma.candidate.count({ where });
  if (!apply) {
    console.log(`Dry run: ${total} candidate(s) created before ${before.toISOString().slice(0, 10)} would be anonymised. Re-run with --yes to apply.`);
    return;
  }
  const rows = await prisma.candidate.findMany({ where });
  for (const row of rows) {
    const c = anonymizeCandidate(row);
    await prisma.$transaction([
      prisma.candidate.update({
        where: { id: row.id },
        data: {
          fullName: c.fullName, email: c.email, mobile: null, rollNumber: null, xPercentage: null,
          xiiPercentage: null, majorCpi: null, discipline: null, programme: null, extra: {},
        },
      }),
      prisma.candidateLoginLog.updateMany({
        where: { candidateId: row.id },
        data: LOG_SCRUB.loginLog,
      }),
      prisma.activityLog.updateMany({
        where: { candidateId: row.id },
        data: LOG_SCRUB.activityLog,
      }),
      prisma.emailDispatch.updateMany({
        where: { candidateId: row.id },
        data: EMAIL_DISPATCH_SCRUB(row.id),
      }),
      prisma.aiQuestionScore.updateMany({
        where: { attemptQuestion: { attempt: { candidateId: row.id } } },
        data: AI_SCORE_SCRUB,
      }),
    ]);
  }
  // An account goes only when none of its applications still holds personal data.
  const accounts = await prisma.candidateAccount.findMany({
    where: { NOT: { email: { endsWith: '@invalid' } }, applications: { every: { fullName: 'Anonymised' } } },
    select: { id: true },
  });
  for (const a of accounts) await prisma.candidateAccount.update({ where: { id: a.id }, data: anonymizeAccount(a.id) });
  await prisma.adminAuditLog.create({
    data: { action: 'CANDIDATES_PURGED', entity: 'candidate', metadata: { before: before.toISOString(), count: rows.length, accounts: accounts.length, via: 'cli' } },
  });
  console.log(`Anonymised ${rows.length} candidate(s) created before ${before.toISOString().slice(0, 10)}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err: unknown) => {
      console.error('purge-candidates failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
