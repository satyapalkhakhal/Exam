// shared/utils/piiMask.ts
// Masks emails and mobiles before they reach a log line.

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '****';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0] ?? ''}****${domain}`;
  return `${local[0]}****${local[local.length - 1]}${domain}`;
}

export function maskMobile(mobile: string): string {
  if (mobile.length <= 4) return '*'.repeat(mobile.length);
  return `${mobile.slice(0, 2)}${'*'.repeat(mobile.length - 4)}${mobile.slice(-2)}`;
}
