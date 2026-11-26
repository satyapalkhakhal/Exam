// modules/adminAuth/passwordResetEmails.ts
// The two admin password-reset emails: the one-time link, and the notice sent
// after the password changes. Plain HTML in the OTP email's style.

const CONTACT = "If this wasn't you, contact hrd@arihantcapital.com immediately.";
const wrap = (body: string) => `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">${body}</div>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface EmailParts {
  subject: string;
  html: string;
  text: string;
}

export function buildPasswordResetEmail(p: { name: string; link: string; minutes: number }): EmailParts {
  const name = esc(p.name);
  return {
    subject: 'Reset your Arihant Plus admin password',
    text:
      `Hi ${p.name},\n\nWe received a request to reset your Arihant Plus admin password.\n` +
      `Open this link to choose a new one (valid for ${p.minutes} minutes, works once):\n${p.link}\n\n` +
      `If you did not ask for this, you can ignore this email; your password stays the same.\n${CONTACT}`,
    html: wrap(
      `<p>Hi ${name},</p>` +
        '<p>We received a request to reset your Arihant Plus admin password.</p>' +
        `<p><a href="${esc(p.link)}" style="display:inline-block;padding:10px 18px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">Choose a new password</a></p>` +
        `<p>This link is valid for ${p.minutes} minutes and works once. If the button does not open, copy this address into your browser:<br><span style="word-break:break-all">${esc(p.link)}</span></p>` +
        '<p>If you did not ask for this, you can ignore this email; your password stays the same.</p>' +
        `<p>${CONTACT}</p>`,
    ),
  };
}

/** "26 Nov 2026, 3:05 pm IST" */
function istLabel(at: Date): string {
  return `${new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at)} IST`;
}

export function buildPasswordChangedEmail(p: { name: string; at: Date }): EmailParts {
  const when = istLabel(p.at);
  return {
    subject: 'Your Arihant Plus admin password was changed',
    text: `Hi ${p.name},\n\nYour Arihant Plus admin password was changed on ${when}, and every signed-in session was signed out.\n${CONTACT}`,
    html: wrap(
      `<p>Hi ${esc(p.name)},</p>` +
        `<p>Your Arihant Plus admin password was changed on <b>${when}</b>, and every signed-in session was signed out.</p>` +
        `<p>${CONTACT}</p>`,
    ),
  };
}
