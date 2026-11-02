// modules/messaging/candidateEmails.ts
// Candidate notification emails, sent manually from the admin panel
// (docs/email-templates.md):
// - buildSubmissionEmail: confirms an exam was received (manual or auto submit).
// - buildShortlistEmail: tells a shortlisted candidate they qualified for the
//   next round.
// Each returns { subject, html, text }, the shape sendEmail takes. The subject
// and the body paragraphs come from an editable template { subject, body } with
// {placeholder} tokens (the built-in defaults below when none is given); the
// branded layout, details table, link button, instruction list and sign-off
// are always added here. The template text and every substituted value are
// HTML-escaped, so an admin cannot inject markup. A placeholder with no value
// renders empty. Candidates never see marks or rankings (design §8), so
// neither email carries them. Times are shown in IST. The HTML is table-based
// with inline styles so it renders in Gmail/Outlook.

import type { EmailTemplateKey } from '@exam/shared';

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface EmailTemplate {
  subject: string;
  body: string;
}

export const DEFAULT_HR_CONTACT = 'hrd@arihantcapital.com';
const BRAND = 'Arihant Capital';
const PRODUCT = 'Arihant Capital Recruitment Assessment';
const PRIMARY = '#1F71F4';

// ---- helpers ------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** e.g. "3 Nov 2026, 2:05 pm IST". */
export function formatIst(at: Date): string {
  const s = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
  return `${s} IST`;
}

// ---- placeholders ---------------------------------------------------------------

const TOKEN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** Tokens in `text` that are not in `allowed` (each listed once, in order of appearance). */
export function unknownPlaceholders(text: string, allowed: readonly string[]): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(TOKEN)) if (!allowed.includes(m[1]!)) found.add(m[1]!);
  return [...found];
}

/** Single-pass substitution: a missing value renders empty and substituted text is never re-scanned. */
export function fillPlaceholders(text: string, values: Record<string, string | undefined>): string {
  return text.replace(TOKEN, (_m, name: string) => values[name] ?? '');
}

const bodyParagraphs = (body: string): string[] =>
  body
    .split(/\r?\n[ \t]*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);

const oneLine = (subject: string): string => subject.replace(/\s*[\r\n]+\s*/g, ' ').trim();

const firstName = (fullName: string): string => fullName.trim().split(/\s+/)[0] || 'Candidate';

type Row = [label: string, value: string];

function detailsTableHtml(rows: Row[]): string {
  const cells = rows
    .map(
      ([label, value]) =>
        '<tr>' +
        `<td style="padding:8px 12px;color:#555;font-size:13px;border-bottom:1px solid #eee;width:40%">${escapeHtml(label)}</td>` +
        `<td style="padding:8px 12px;color:#111;font-size:13px;font-weight:bold;border-bottom:1px solid #eee">${escapeHtml(value)}</td>` +
        '</tr>',
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #eee;border-radius:6px;border-collapse:separate;margin:16px 0">${cells}</table>`;
}

const detailsText = (rows: Row[]): string => rows.map(([l, v]) => `  ${l}: ${v}`).join('\n');

const paragraphsHtml = (ps: string[]): string =>
  ps.map((p) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#111">${p}</p>`).join('');

/** The shared shell: header band, body, footer. `bodyHtml` must already be escaped. */
function layout(opts: { preheader: string; heading: string; bodyHtml: string; contact: string }): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#f4f6fa">' +
    `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(opts.preheader)}</div>` +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f6fa;padding:24px 0"><tr><td align="center">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;font-family:Arial,Helvetica,sans-serif">' +
    `<tr><td style="background:${PRIMARY};padding:20px 28px;color:#ffffff;font-size:18px;font-weight:bold">${BRAND}</td></tr>` +
    `<tr><td style="padding:28px">` +
    `<h1 style="margin:0 0 18px;font-size:20px;color:#111">${escapeHtml(opts.heading)}</h1>` +
    opts.bodyHtml +
    '</td></tr>' +
    '<tr><td style="padding:16px 28px;background:#f9fafc;border-top:1px solid #eee;font-size:12px;line-height:1.5;color:#777">' +
    `Questions? Write to <a href="mailto:${escapeHtml(opts.contact)}" style="color:${PRIMARY}">${escapeHtml(opts.contact)}</a>.<br>` +
    `This is an automated message from the ${PRODUCT}. Please do not reply to this email.` +
    '</td></tr></table></td></tr></table></body></html>'
  );
}

/** Escaped paragraphs; a single newline inside one becomes a line break. */
const templateParagraphsHtml = (ps: string[]): string => paragraphsHtml(ps.map((p) => escapeHtml(p).replace(/\r?\n/g, '<br>')));

const textFooter = (contact: string) =>
  `Questions? Write to ${contact}.\nThis is an automated message from the ${PRODUCT}. Please do not reply to this email.`;

// ---- built-in templates -----------------------------------------------------------

export const DEFAULT_EMAIL_TEMPLATES: Record<EmailTemplateKey, EmailTemplate> = {
  SUBMISSION_RECEIVED: {
    subject: 'We have received your exam submission — {role}',
    body: [
      'Dear {firstName},',
      'Thank you for taking the {role} assessment. Your answers have been saved and submitted, and no further changes can be made.',
      'Our team will now review every submission. If you are shortlisted for the next round, we will contact you by email with the details. ' +
        'There is no need to take any action in the meantime.',
      'Please keep this email for your records; quote your candidate code if you contact us.',
    ].join('\n\n'),
  },
  SHORTLISTED: {
    subject: 'Congratulations! You have been shortlisted for the {roundName} — {role}',
    body: [
      'Dear {firstName},',
      'We are pleased to let you know that, based on your written assessment for the {role} role, you have been shortlisted for the {roundName}.',
      'The details are listed below. If no date and time are shown yet, we will send them to you shortly.',
      'Please confirm your availability by writing to {contactEmail}, before the confirmation deadline if one is shown below.',
      'Congratulations once again, and we look forward to speaking with you.',
    ].join('\n\n'),
  },
};

interface CommonParams {
  fullName: string;
  candidateCode: string;
  jobRoleName: string;
  /** HR contact shown in the footer; defaults to DEFAULT_HR_CONTACT. */
  contactEmail?: string;
}

const commonValues = (p: CommonParams, contact: string): Record<string, string> => ({
  firstName: firstName(p.fullName),
  fullName: p.fullName,
  role: p.jobRoleName,
  candidateCode: p.candidateCode,
  contactEmail: contact,
});

const SIGN_OFF_TEAM = `Talent Acquisition Team, ${BRAND}`;

// ---- 1. Submission received -----------------------------------------------------

export interface SubmissionEmailParams extends CommonParams {
  submittedAt: Date;
  /** AUTO when the timer ran out and the exam was submitted automatically. */
  submitType: 'MANUAL' | 'AUTO';
  answeredCount: number;
  questionCount: number;
}

export function buildSubmissionEmail(p: SubmissionEmailParams, template: EmailTemplate = DEFAULT_EMAIL_TEMPLATES.SUBMISSION_RECEIVED): EmailContent {
  const contact = p.contactEmail ?? DEFAULT_HR_CONTACT;
  const submittedAt = formatIst(p.submittedAt);
  const values = {
    ...commonValues(p, contact),
    submittedAt,
    answeredCount: String(p.answeredCount),
    questionCount: String(p.questionCount),
  };
  const subject = oneLine(fillPlaceholders(template.subject, values));
  const paras = bodyParagraphs(fillPlaceholders(template.body, values));
  const how = p.submitType === 'AUTO' ? 'Submitted automatically when the time ran out' : 'Submitted by you';
  const rows: Row[] = [
    ['Role', p.jobRoleName],
    ['Candidate code', p.candidateCode],
    ['Submitted at', submittedAt],
    ['Submission', how],
    ['Questions answered', `${p.answeredCount} of ${p.questionCount}`],
  ];

  const html = layout({
    preheader: `Your ${p.jobRoleName} assessment was submitted on ${submittedAt}.`,
    heading: 'Submission received',
    contact,
    bodyHtml:
      templateParagraphsHtml(paras) +
      detailsTableHtml(rows) +
      paragraphsHtml([`Best wishes,<br>${SIGN_OFF_TEAM}`]),
  });
  const text = [...paras.flatMap((x) => [x, '']), detailsText(rows), '', `Best wishes,\n${SIGN_OFF_TEAM}`, '', textFooter(contact)].join('\n');
  return { subject, html, text };
}

// ---- 2. Shortlisted for the next round -------------------------------------------

export interface NextRoundDetails {
  /** e.g. "Technical interview". Defaults to "next round" in {roundName}. */
  name?: string;
  /** e.g. "Video call (Google Meet)" or "In person". */
  mode?: string;
  scheduledAt?: Date;
  /** Address for an in-person round. */
  venue?: string;
  /** Meeting or booking link; shown as a button. Must be https. */
  link?: string;
  /** Label for the button; defaults to "Join / confirm". */
  linkLabel?: string;
  /** Free text, one paragraph per line (what to bring, duration, panel…). */
  instructions?: string;
  /** Ask the candidate to confirm by this time. */
  confirmBy?: Date;
}

export interface ShortlistEmailParams extends CommonParams {
  nextRound?: NextRoundDetails;
}

export function buildShortlistEmail(p: ShortlistEmailParams, template: EmailTemplate = DEFAULT_EMAIL_TEMPLATES.SHORTLISTED): EmailContent {
  const contact = p.contactEmail ?? DEFAULT_HR_CONTACT;
  const r = p.nextRound ?? {};
  const roundLabel = r.name?.trim() || 'next round';
  const values = {
    ...commonValues(p, contact),
    roundName: roundLabel,
    scheduledAt: r.scheduledAt ? formatIst(r.scheduledAt) : '',
    confirmBy: r.confirmBy ? formatIst(r.confirmBy) : '',
  };
  const subject = oneLine(fillPlaceholders(template.subject, values));
  const paras = bodyParagraphs(fillPlaceholders(template.body, values));

  const rows: Row[] = [
    ['Role', p.jobRoleName],
    ['Candidate code', p.candidateCode],
    ['Next round', r.name?.trim() || 'Details to follow'],
  ];
  if (r.mode) rows.push(['Mode', r.mode]);
  if (r.scheduledAt) rows.push(['Date and time', formatIst(r.scheduledAt)]);
  if (r.venue) rows.push(['Venue', r.venue]);
  if (r.confirmBy) rows.push(['Please confirm by', formatIst(r.confirmBy)]);

  const link = r.link && /^https:\/\//i.test(r.link) ? r.link : undefined;
  const instructionLines = (r.instructions ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const buttonHtml = link
    ? `<p style="margin:8px 0 22px"><a href="${escapeHtml(link)}" style="display:inline-block;background:${PRIMARY};color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:12px 22px;border-radius:6px">${escapeHtml(r.linkLabel?.trim() || 'Join / confirm')}</a></p>`
    : '';
  const instructionsHtml = instructionLines.length
    ? `<p style="margin:0 0 6px;font-size:14px;font-weight:bold;color:#111">Before the round</p>` +
      `<ul style="margin:0 0 14px;padding-left:20px;font-size:14px;line-height:1.6;color:#111">${instructionLines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
    : '';

  const html = layout({
    preheader: `You have been shortlisted for the ${roundLabel} for the ${p.jobRoleName} role.`,
    heading: 'You have been shortlisted',
    contact,
    bodyHtml:
      templateParagraphsHtml(paras) +
      detailsTableHtml(rows) +
      buttonHtml +
      instructionsHtml +
      paragraphsHtml([`Warm regards,<br>${SIGN_OFF_TEAM}`]),
  });

  const text = [
    ...paras.flatMap((x) => [x, '']),
    detailsText(rows),
    ...(link ? ['', `${r.linkLabel?.trim() || 'Join / confirm'}: ${link}`] : []),
    ...(instructionLines.length ? ['', 'Before the round:', ...instructionLines.map((l) => `  - ${l}`)] : []),
    '',
    `Warm regards,\n${SIGN_OFF_TEAM}`,
    '',
    textFooter(contact),
  ].join('\n');
  return { subject, html, text };
}
