import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EMAIL_TEMPLATES,
  buildRejectionEmail,
  buildShortlistEmail,
  buildSubmissionEmail,
  escapeHtml,
  fillPlaceholders,
  formatIst,
  unknownPlaceholders,
} from '../src/modules/messaging/candidateEmails.js';

const base = { fullName: 'Ajith K K', candidateCode: 'ARC-0042', jobRoleName: 'Backend Engineer' };

test('formatIst shows Indian time', () => {
  assert.equal(formatIst(new Date('2026-11-03T08:35:00Z')), '3 Nov 2026, 2:05 pm IST');
});

test('submission email: subject, IST time, counts, auto-submit wording, no marks', () => {
  const e = buildSubmissionEmail({ ...base, submittedAt: new Date('2026-11-03T08:35:00Z'), submitType: 'AUTO', answeredCount: 2, questionCount: 3 });
  assert.equal(e.subject, 'We have received your exam submission — Backend Engineer');
  for (const part of [e.html, e.text]) {
    assert.match(part, /Dear Ajith,/);
    assert.match(part, /ARC-0042/);
    assert.match(part, /3 Nov 2026, 2:05 pm IST/);
    assert.match(part, /2 of 3/);
    assert.match(part, /automatically when the time ran out/);
    assert.doesNotMatch(part, /marks|score|rank/i);
  }
  assert.match(e.text, /hrd@arihantcapital\.com/);
});

test('submission email: manual wording and custom contact', () => {
  const e = buildSubmissionEmail({ ...base, submittedAt: new Date(), submitType: 'MANUAL', answeredCount: 3, questionCount: 3, contactEmail: 'jobs@x.test' });
  assert.match(e.text, /Submitted by you/);
  assert.match(e.html, /mailto:jobs@x\.test/);
});

test('shortlist email with full next-round details', () => {
  const e = buildShortlistEmail({
    ...base,
    nextRound: {
      name: 'Technical interview',
      mode: 'Video call',
      scheduledAt: new Date('2026-11-10T05:30:00Z'),
      link: 'https://meet.example.com/abc',
      linkLabel: 'Join the call',
      instructions: 'Keep your ID ready\n\nJoin 10 minutes early',
      confirmBy: new Date('2026-11-07T12:30:00Z'),
    },
  });
  assert.equal(e.subject, 'Congratulations! You have been shortlisted for the Technical interview — Backend Engineer');
  assert.match(e.html, /href="https:\/\/meet\.example\.com\/abc"/);
  assert.match(e.html, /<li>Keep your ID ready<\/li><li>Join 10 minutes early<\/li>/);
  assert.match(e.text, /Date and time: 10 Nov 2026, 11:00 am IST/);
  assert.match(e.text, /Join the call: https:\/\/meet\.example\.com\/abc/);
  assert.match(e.text, /Please confirm by: 7 Nov 2026, 6:00 pm IST/);
});

test('shortlist email with no details falls back gracefully', () => {
  const e = buildShortlistEmail(base);
  assert.equal(e.subject, 'Congratulations! You have been shortlisted for the next round — Backend Engineer');
  assert.match(e.text, /Next round: Details to follow/);
  assert.match(e.text, /we will send them to you shortly/);
  assert.doesNotMatch(e.html, /<a href="http(?!s:\/\/)|<ul/);
});

test('shortlist email drops a non-https link', () => {
  const e = buildShortlistEmail({ ...base, nextRound: { link: 'javascript:alert(1)' } });
  assert.doesNotMatch(e.html, /javascript:/);
  assert.doesNotMatch(e.text, /javascript:/);
});

test('every interpolated value is HTML-escaped', () => {
  const evil = '<script>alert("x")</script>';
  const e = buildShortlistEmail({ fullName: evil, candidateCode: evil, jobRoleName: evil, nextRound: { name: evil, venue: evil, instructions: evil } });
  assert.doesNotMatch(e.html, /<script>/);
  assert.match(e.html, new RegExp(escapeHtml('<script>')));
  const s = buildSubmissionEmail({ fullName: evil, candidateCode: evil, jobRoleName: evil, submittedAt: new Date(), submitType: 'MANUAL', answeredCount: 0, questionCount: 1 });
  assert.doesNotMatch(s.html, /<script>/);
});

const submission = { ...base, submittedAt: new Date('2026-11-03T08:35:00Z'), submitType: 'MANUAL' as const, answeredCount: 2, questionCount: 3 };

test('placeholders: unknown tokens are listed once, known ones pass', () => {
  assert.deepEqual(unknownPlaceholders('Hi {firstName} {nope} {nope} {role} {Bad1}', ['firstName', 'role']), ['nope', 'Bad1']);
  assert.deepEqual(unknownPlaceholders('no tokens { here } {1x}', ['firstName']), []);
});

test('placeholders: a missing value renders empty and substituted text is not re-scanned', () => {
  assert.equal(fillPlaceholders('at {scheduledAt}.', {}), 'at .');
  assert.equal(fillPlaceholders('{a}{b}', { a: '{b}', b: 'x' }), '{b}x');
});

test('custom template: subject and body use placeholders, layout stays', () => {
  const e = buildSubmissionEmail(submission, {
    subject: 'Got it, {firstName} ({candidateCode})',
    body: 'Hi {fullName},\n\nYou answered {answeredCount} of {questionCount} on {submittedAt}.\nWrite to {contactEmail}.',
  });
  assert.equal(e.subject, 'Got it, Ajith (ARC-0042)');
  assert.match(e.text, /^Hi Ajith K K,\n\nYou answered 2 of 3 on 3 Nov 2026, 2:05 pm IST\.\nWrite to hrd@arihantcapital\.com\./);
  assert.match(e.html, /You answered 2 of 3 on .*<br>Write to /);
  assert.match(e.html, /Questions answered/);
  assert.match(e.text, /Talent Acquisition Team/);
});

test('custom template: template text and values are escaped, subject stays one line', () => {
  const e = buildShortlistEmail(
    { ...base, fullName: '<b>Eve</b>' },
    { subject: 'Hi\r\nBcc: x@y.z {fullName}', body: '<script>alert(1)</script> {fullName} & {unknown}' },
  );
  assert.doesNotMatch(e.subject, /[\r\n]/);
  assert.doesNotMatch(e.html, /<script>|<b>Eve/);
  assert.match(e.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &lt;b&gt;Eve&lt;\/b&gt; &amp;<\/p>/);
});

test('shortlist placeholders without next-round data render empty', () => {
  const e = buildShortlistEmail(base, { subject: 's', body: 'On [{scheduledAt}] confirm by [{confirmBy}] for {roundName}' });
  assert.match(e.text, /On \[\] confirm by \[\] for next round/);
});

test('default templates read well without optional next-round fields', () => {
  assert.doesNotMatch(buildShortlistEmail(base).text, /before \.|\{|\}/);
  assert.doesNotMatch(buildSubmissionEmail(submission).text, /\{|\}/);
  assert.match(DEFAULT_EMAIL_TEMPLATES.SHORTLISTED.body, /\{roundName\}/);
});

test('rejection email: default subject, details table without next-round rows, contact in text', () => {
  const e = buildRejectionEmail({ ...base, contactEmail: 'hr@x.test' });
  assert.equal(e.subject, 'Update on your application — Backend Engineer');
  assert.match(e.html, /Dear Ajith,/);
  assert.match(e.html, />Role</);
  assert.match(e.html, /ARC-0042/);
  assert.doesNotMatch(e.html, /Next round/);
  assert.match(e.text, /hr@x\.test/);
  assert.match(e.text, /will not be moving forward/);
});

test('rejection email escapes interpolated values', () => {
  const e = buildRejectionEmail({ ...base, fullName: '<b>x</b>' });
  assert.doesNotMatch(e.html, /<b>x<\/b>/);
});
