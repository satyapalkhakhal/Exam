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
// renders empty. Candidates never see rankings. Marks appear in one place only:
// the Shortlisted email's "Your assessment" card, and only once marking is
// complete (total and percentage, never per-question). Times are shown in IST.
// The HTML is table-based with inline styles so it renders in Gmail/Outlook.
//
// Look (approved mockup 2026-11-05): Arihant Capital header with a purple-to-green
// rule, purple headings and buttons, and on the two outcome emails a horizontal
// ArihantPlus strip as the last row. Images (logo, app icon) load from
// `assetBaseUrl` (the exam site's public URL); without it they are left out and
// the text still reads correctly.

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

// ArihantPlus palette (matches the web banner).
const C = {
  primary: '#5b22a3',
  purple: '#a35fe0',
  green: '#00a84f',
  ink: '#1d1530',
  muted: '#5e5670',
  faint: '#7a7388',
  lav: '#f6effe',
  lav2: '#ead9fb',
  line: '#ece6f4',
  page: '#f4f2f8',
  okBg: '#e3f7ec',
  okInk: '#007a3a',
} as const;
const FONT = 'Arial,Helvetica,sans-serif';
const RISK_LINE = 'Investments in securities markets are subject to market risks. Read all related documents carefully before investing.';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.msf.acml';
const APP_STORE_URL = 'https://apps.apple.com/in/app/arihant-plus/id1643484698';
const WEB_TRADING_URL = 'https://web.arihantplus.com';

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

/** "34.5", "40": at most one decimal, no trailing ".0". */
const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));

/** "52 min 30 s", "1 h 5 min", "40 s"; empty when either time is missing (same wording as the receipt page). */
function timeTaken(startedAt: Date | null, submittedAt: Date | null): string {
  if (!startedAt || !submittedAt) return '';
  const s = Math.max(0, Math.round((submittedAt.getTime() - startedAt.getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return sec > 0 ? `${m} min ${sec} s` : `${m} min`;
  return `${sec} s`;
}

const assetUrl = (base: string | undefined, path: string): string | undefined => {
  const b = base?.trim().replace(/\/+$/, '');
  return b && /^https?:\/\//i.test(b) ? `${b}${path}` : undefined;
};

function rowsHtml(rows: Row[]): string {
  return rows
    .map(([label, value], i) => {
      const b = i < rows.length - 1 ? `border-bottom:1px solid ${C.line};` : '';
      return (
        '<tr>' +
        `<td style="padding:10px 14px;background:${C.lav};color:${C.muted};font-size:13px;width:40%;${b}">${escapeHtml(label)}</td>` +
        `<td style="padding:10px 14px;color:${C.ink};font-size:13px;font-weight:bold;${b}">${escapeHtml(value)}</td>` +
        '</tr>'
      );
    })
    .join('');
}

function detailsTableHtml(rows: Row[]): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid ${C.line};border-radius:8px;border-collapse:separate;margin:0 0 20px;overflow:hidden">${rowsHtml(rows)}</table>`;
}

const detailsText = (rows: Row[]): string => rows.map(([l, v]) => `  ${l}: ${v}`).join('\n');

const paragraphsHtml = (ps: string[]): string =>
  ps.map((p) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.65;color:${C.ink}">${p}</p>`).join('');

const sectionLabelHtml = (t: string): string =>
  `<p style="margin:22px 0 8px;font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${C.muted}">${escapeHtml(t)}</p>`;

function buttonHtml(href: string, label: string): string {
  return `<p style="margin:4px 0 22px"><a href="${escapeHtml(href)}" style="display:inline-block;background:${C.primary};color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:12px 24px;border-radius:8px">${escapeHtml(label)}</a></p>`;
}

// ---- ArihantPlus strip (last row of the outcome emails) ------------------------

function chipHtml(label: string, featured = false): string {
  const look = featured
    ? `background:${C.primary};color:#ffffff;border:1px solid ${C.primary};`
    : `background:#ffffff;color:${C.ink};border:1px solid ${C.lav2};`;
  return `<span style="display:inline-block;${look}border-radius:999px;padding:4px 10px;margin:0 6px 6px 0;font-size:12px;font-weight:bold;white-space:nowrap">${escapeHtml(label)}</span>`;
}

function storeButtonHtml(href: string, top: string, label: string): string {
  return (
    `<a href="${href}" style="display:block;width:128px;background:#16101f;color:#ffffff;text-decoration:none;border-radius:8px;padding:7px 12px;margin:0 0 8px auto;text-align:left;font-family:${FONT}">` +
    `<span style="display:block;font-size:9px;letter-spacing:.5px;text-transform:uppercase;opacity:.75">${top}</span>` +
    `<span style="display:block;font-size:13px;font-weight:bold">${label}</span></a>`
  );
}

function plusStripHtml(assetBaseUrl: string | undefined): string {
  const icon = assetUrl(assetBaseUrl, '/email/arihantplus-icon.jpg');
  const iconCell = icon
    ? `<td style="padding-right:10px"><img src="${escapeHtml(icon)}" width="32" height="32" alt="ArihantPlus" style="display:block;border-radius:8px;border:0"></td>`
    : '';
  return (
    `<tr><td style="padding:20px 28px 18px;background:${C.lav};background-image:linear-gradient(100deg,#faf5ff 0%,#e7d4fa 100%);border-top:1px solid ${C.lav2}">` +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>' +
    '<td valign="middle" style="padding-right:14px">' +
    '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
    iconCell +
    `<td style="font-size:17px;font-weight:bold;color:${C.ink}">Arihant<span style="color:${C.green};font-size:13px;letter-spacing:1px;padding-left:2px">PLUS</span>` +
    `<div style="font-size:10px;font-weight:bold;letter-spacing:1.1px;text-transform:uppercase;color:${C.muted};margin-top:2px">Trading &amp; investing app by Arihant Capital</div></td>` +
    '</tr></table>' +
    `<div style="font-size:13px;line-height:1.55;color:${C.muted};margin:10px 0 10px"><b style="color:${C.primary}">Algo Trading</b> with Quantlab, Stratzy and Trade Bridge, plus stocks, F&amp;O, IPO and mutual funds in one app.</div>` +
    chipHtml('Algo Trading', true) +
    ['F&O', 'IPO & NCD', 'Mutual Funds & SIP', 'Research', 'Commodity'].map((c) => chipHtml(c)).join('') +
    '</td>' +
    '<td valign="middle" align="right" width="140">' +
    storeButtonHtml(PLAY_STORE_URL, 'Get it on', 'Google Play') +
    storeButtonHtml(APP_STORE_URL, 'Download on the', 'App Store') +
    `<a href="${WEB_TRADING_URL}" style="display:block;text-align:right;font-size:12px;font-weight:bold;color:${C.primary};text-decoration:none">web.arihantplus.com &rarr;</a>` +
    '</td>' +
    '</tr></table>' +
    `<div style="font-size:10.5px;line-height:1.45;color:${C.muted};margin-top:12px">${escapeHtml(RISK_LINE)}</div>` +
    '</td></tr>'
  );
}

const plusStripText = (): string =>
  [
    '---',
    'ArihantPlus, the trading & investing app by Arihant Capital',
    'Algo Trading with Quantlab, Stratzy and Trade Bridge, plus stocks, F&O, IPO and mutual funds in one app.',
    `Google Play: ${PLAY_STORE_URL}`,
    `App Store: ${APP_STORE_URL}`,
    `Web: ${WEB_TRADING_URL}`,
    RISK_LINE,
  ].join('\n');

// ---- shared shell ----------------------------------------------------------------

/** Header, body, footer and (outcome emails) the ArihantPlus strip. `bodyHtml` must already be escaped. */
function layout(opts: {
  preheader: string;
  heading: string;
  bodyHtml: string;
  contact: string;
  assetBaseUrl?: string;
  pill?: string;
  plusStrip?: boolean;
}): string {
  const logo = assetUrl(opts.assetBaseUrl, '/email/arihant-capital-logo.png');
  const logoCell = logo
    ? `<td width="46" style="padding-right:12px"><img src="${escapeHtml(logo)}" width="34" height="32" alt="Arihant Capital" style="display:block;border:0"></td>`
    : '';
  const pill = opts.pill
    ? `<span style="display:inline-block;font-size:11px;font-weight:bold;letter-spacing:.8px;text-transform:uppercase;color:${C.okInk};background:${C.okBg};border-radius:999px;padding:4px 10px;margin-bottom:12px">${escapeHtml(opts.pill)}</span>`
    : '';
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    `<body style="margin:0;padding:0;background:${C.page}">` +
    `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(opts.preheader)}</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${C.page};padding:24px 12px;font-family:${FONT}"><tr><td align="center">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid ${C.line};font-family:${FONT}">` +
    // header
    '<tr><td style="padding:20px 28px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>' +
    logoCell +
    `<td style="font-size:17px;font-weight:bold;color:${C.ink}">${BRAND}<div style="font-size:12px;font-weight:normal;color:${C.muted};margin-top:2px">Talent Acquisition</div></td>` +
    '</tr></table></td></tr>' +
    `<tr><td style="height:4px;line-height:4px;font-size:0;background:${C.purple};background-image:linear-gradient(90deg,${C.purple},${C.green})">&nbsp;</td></tr>` +
    // body
    '<tr><td style="padding:28px 28px 8px">' +
    pill +
    `<h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;color:${C.primary}">${escapeHtml(opts.heading)}</h1>` +
    opts.bodyHtml +
    '</td></tr>' +
    // footer
    `<tr><td style="padding:16px 28px 20px;background:#faf8fc;border-top:1px solid ${C.line};font-size:12px;line-height:1.6;color:${C.faint}">` +
    `Questions? Write to <a href="mailto:${escapeHtml(opts.contact)}" style="color:${C.primary}">${escapeHtml(opts.contact)}</a>.<br>` +
    `This is an automated message from the ${PRODUCT}. Please do not reply to this email.` +
    '</td></tr>' +
    (opts.plusStrip ? plusStripHtml(opts.assetBaseUrl) : '') +
    '</table></td></tr></table></body></html>'
  );
}

/** Escaped paragraphs; a single newline inside one becomes a line break. */
const templateParagraphsHtml = (ps: string[]): string => paragraphsHtml(ps.map((p) => escapeHtml(p).replace(/\r?\n/g, '<br>')));

const textFooter = (contact: string, plusStrip = false) =>
  `Questions? Write to ${contact}.\nThis is an automated message from the ${PRODUCT}. Please do not reply to this email.` +
  (plusStrip ? `\n\n${plusStripText()}` : '');

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
      'Your submission summary is below, followed by what happens next.',
    ].join('\n\n'),
  },
  REJECTED: {
    subject: 'Update on your application — {role}',
    body: [
      'Dear {firstName},',
      'Thank you for your interest in the {role} role at Arihant Capital and for the time you put into the written assessment.',
      'After careful review, we will not be moving forward with your application at this time. This decision was not easy, given the strength of the applications we received.',
      'We will keep your details on file and may contact you about future openings that match your profile.',
      'We wish you every success.',
    ].join('\n\n'),
  },
};

interface CommonParams {
  fullName: string;
  candidateCode: string;
  jobRoleName: string;
  /** HR contact shown in the footer; defaults to DEFAULT_HR_CONTACT. */
  contactEmail?: string;
  /** Exam site's public URL, for the logo and app icon. Images are left out without it. */
  assetBaseUrl?: string;
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
    assetBaseUrl: p.assetBaseUrl,
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

/** The candidate's submission and, once marking is complete, their score. */
export interface AssessmentSummary {
  startedAt: Date | null;
  submittedAt: Date | null;
  submitType: 'MANUAL' | 'AUTO' | null;
  answeredCount: number;
  questionCount: number;
  /** Null until the evaluator completes marking. */
  score: { total: number; max: number; percentage: number } | null;
}

export interface ShortlistEmailParams extends CommonParams {
  nextRound?: NextRoundDetails;
  assessment?: AssessmentSummary;
}

function assessmentRows(p: ShortlistEmailParams): Row[] {
  const rows: Row[] = [
    ['Role', p.jobRoleName],
    ['Candidate code', p.candidateCode],
  ];
  const a = p.assessment;
  if (!a) return rows;
  if (a.submittedAt) rows.push(['Submitted at', formatIst(a.submittedAt)]);
  if (a.submitType) rows.push(['Submission', a.submitType === 'AUTO' ? 'Submitted automatically when the time ran out' : 'Submitted by you']);
  if (a.questionCount > 0) rows.push(['Questions answered', `${a.answeredCount} of ${a.questionCount}`]);
  const taken = timeTaken(a.startedAt, a.submittedAt);
  if (taken) rows.push(['Time taken', taken]);
  return rows;
}

function scoreHtml(score: NonNullable<AssessmentSummary['score']>): string {
  const pct = Math.min(100, Math.max(0, Math.round(score.percentage)));
  const bar =
    pct > 0
      ? `<td width="${pct}%" style="height:8px;line-height:8px;font-size:0;background:${C.purple};background-image:linear-gradient(90deg,${C.purple},${C.primary})">&nbsp;</td>`
      : '';
  return (
    `<tr><td style="padding:18px 18px 14px;background:${C.lav}">` +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>' +
    `<td valign="bottom"><div style="font-size:12px;color:${C.muted}">Score</div>` +
    `<div style="font-size:30px;line-height:1.1;font-weight:bold;color:${C.primary}">${escapeHtml(fmtNum(score.total))}<span style="font-size:16px;color:${C.muted};font-weight:normal"> / ${escapeHtml(fmtNum(score.max))}</span></div></td>` +
    `<td valign="bottom" align="right"><span style="display:inline-block;font-size:14px;font-weight:bold;color:${C.okInk};background:${C.okBg};border-radius:999px;padding:5px 12px">${escapeHtml(fmtNum(score.percentage))}%</span></td>` +
    '</tr></table>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:12px;border-radius:999px;overflow:hidden"><tr>' +
    bar +
    `<td style="height:8px;line-height:8px;font-size:0;background:${C.lav2}">&nbsp;</td>` +
    '</tr></table>' +
    '</td></tr>'
  );
}

function assessmentCardHtml(p: ShortlistEmailParams): string {
  const score = p.assessment?.score;
  return (
    sectionLabelHtml('Your assessment') +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid ${C.lav2};border-radius:12px;border-collapse:separate;overflow:hidden;margin:0 0 8px">` +
    (score ? scoreHtml(score) : '') +
    `<tr><td style="padding:0"><table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rowsHtml(assessmentRows(p))}</table></td></tr>` +
    '</table>'
  );
}

export function buildShortlistEmail(p: ShortlistEmailParams, template: EmailTemplate = DEFAULT_EMAIL_TEMPLATES.SHORTLISTED): EmailContent {
  const contact = p.contactEmail ?? DEFAULT_HR_CONTACT;
  const r = p.nextRound ?? {};
  const roundLabel = r.name?.trim() || 'next round';
  const score = p.assessment?.score ?? null;
  const values = {
    ...commonValues(p, contact),
    roundName: roundLabel,
    scheduledAt: r.scheduledAt ? formatIst(r.scheduledAt) : '',
    confirmBy: r.confirmBy ? formatIst(r.confirmBy) : '',
    score: score ? fmtNum(score.total) : '',
    maxScore: score ? fmtNum(score.max) : '',
    percentage: score ? fmtNum(score.percentage) : '',
  };
  const subject = oneLine(fillPlaceholders(template.subject, values));
  const paras = bodyParagraphs(fillPlaceholders(template.body, values));

  const roundRows: Row[] = [];
  if (r.mode) roundRows.push(['Mode', r.mode]);
  if (r.scheduledAt) roundRows.push(['Date and time', formatIst(r.scheduledAt)]);
  if (r.venue) roundRows.push(['Venue', r.venue]);
  if (r.confirmBy) roundRows.push(['Please confirm by', formatIst(r.confirmBy)]);
  // The round's name alone is already in the body text; it only leads a table of real details.
  if (roundRows.length && r.name?.trim()) roundRows.unshift(['Round', r.name.trim()]);

  const link = r.link && /^https:\/\//i.test(r.link) ? r.link : undefined;
  const linkLabel = r.linkLabel?.trim() || 'Join / confirm';
  const instructionLines = (r.instructions ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const scheduled = Boolean(r.scheduledAt);

  // "What happens next": until a date is set, the candidate is told we will be in touch.
  const soonTitle = 'Our team will contact you soon';
  const soonBody =
    `We will email you the date, time and format of the ${roundLabel} within the next few working days. ` +
    'Please keep an eye on your inbox, including the spam folder, and on calls from Arihant Capital.';
  const confirmLine = `Please confirm your availability by writing to ${contact}${r.confirmBy ? ` before ${formatIst(r.confirmBy)}` : ''}.`;

  const soonHtml =
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-left:4px solid ${C.green};background:#f1fbf5;border-radius:0 10px 10px 0;margin:0 0 20px"><tr><td style="padding:14px 16px">` +
    `<div style="font-size:14px;font-weight:bold;color:${C.ink}">${soonTitle}</div>` +
    `<div style="font-size:13px;line-height:1.6;color:${C.muted};margin-top:4px">${escapeHtml(soonBody)}</div>` +
    '</td></tr></table>';
  const instructionsHtml = instructionLines.length
    ? `<p style="margin:0 0 6px;font-size:14px;font-weight:bold;color:${C.ink}">Before the round</p>` +
      `<ul style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.65;color:${C.ink}">${instructionLines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
    : '';
  const nextHtml =
    sectionLabelHtml(scheduled ? 'Next round' : 'What happens next') +
    (scheduled ? '' : soonHtml) +
    (roundRows.length ? detailsTableHtml(roundRows) : '') +
    (link ? buttonHtml(link, linkLabel) : '') +
    instructionsHtml +
    (scheduled ? paragraphsHtml([escapeHtml(confirmLine)]) : '');

  const html = layout({
    preheader: `You have been shortlisted for the ${roundLabel} for the ${p.jobRoleName} role.`,
    heading: 'Congratulations, you have been shortlisted',
    pill: 'Shortlisted',
    contact,
    assetBaseUrl: p.assetBaseUrl,
    plusStrip: true,
    bodyHtml:
      templateParagraphsHtml(paras) +
      assessmentCardHtml(p) +
      nextHtml +
      paragraphsHtml(['Congratulations once again. We look forward to speaking with you.', `Warm regards,<br>${SIGN_OFF_TEAM}`]),
  });

  const text = [
    ...paras.flatMap((x) => [x, '']),
    'Your assessment:',
    ...(score ? [`  Score: ${fmtNum(score.total)} / ${fmtNum(score.max)} (${fmtNum(score.percentage)}%)`] : []),
    detailsText(assessmentRows(p)),
    '',
    scheduled ? 'Next round:' : `What happens next: ${soonTitle}.`,
    ...(scheduled ? [] : [soonBody]),
    ...(roundRows.length ? [detailsText(roundRows)] : []),
    ...(link ? [`${linkLabel}: ${link}`] : []),
    ...(instructionLines.length ? ['Before the round:', ...instructionLines.map((l) => `  - ${l}`)] : []),
    ...(scheduled ? [confirmLine] : []),
    '',
    'Congratulations once again. We look forward to speaking with you.',
    '',
    `Warm regards,\n${SIGN_OFF_TEAM}`,
    '',
    textFooter(contact, true),
  ].join('\n');
  return { subject, html, text };
}

// ---- 3. Not selected --------------------------------------------------------------

export function buildRejectionEmail(p: CommonParams, template: EmailTemplate = DEFAULT_EMAIL_TEMPLATES.REJECTED): EmailContent {
  const contact = p.contactEmail ?? DEFAULT_HR_CONTACT;
  const values = commonValues(p, contact);
  const subject = oneLine(fillPlaceholders(template.subject, values));
  const paras = bodyParagraphs(fillPlaceholders(template.body, values));
  const rows: Row[] = [
    ['Role', p.jobRoleName],
    ['Candidate code', p.candidateCode],
  ];
  const html = layout({
    preheader: `An update on your application for the ${p.jobRoleName} role.`,
    heading: 'Update on your application',
    contact,
    assetBaseUrl: p.assetBaseUrl,
    plusStrip: true,
    bodyHtml: templateParagraphsHtml(paras) + detailsTableHtml(rows) + paragraphsHtml([`Best wishes,<br>${SIGN_OFF_TEAM}`]),
  });
  const text = [...paras.flatMap((x) => [x, '']), detailsText(rows), '', `Best wishes,\n${SIGN_OFF_TEAM}`, '', textFooter(contact, true)].join('\n');
  return { subject, html, text };
}
