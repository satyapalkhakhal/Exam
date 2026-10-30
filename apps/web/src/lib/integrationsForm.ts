// src/lib/integrationsForm.ts
// Why: the Integrations PUT keeps a stored secret when the field is omitted, so the
// form must send a secret only when the admin actually typed a replacement. The
// saved config tells us which fields are secrets (they come back as {set,last4}).

export interface MaskedSecret {
  set: boolean;
  last4: string | null;
}

export type FormValue = string | boolean;

export function isMaskedSecret(v: unknown): v is MaskedSecret {
  return typeof v === 'object' && v !== null && 'set' in v && 'last4' in v;
}

/** "•••• 1234 (saved)" for a stored secret, null when nothing is stored. */
export function maskedLabel(s: MaskedSecret): string | null {
  return s.set ? `•••• ${s.last4 ?? ''} (saved)`.replace('  ', ' ') : null;
}

export function buildIntegrationPatch(
  form: Record<string, FormValue>,
  saved: Record<string, unknown>,
): Record<string, FormValue> {
  const patch: Record<string, FormValue> = {};
  for (const [key, value] of Object.entries(form)) {
    if (typeof value === 'boolean') {
      patch[key] = value;
      continue;
    }
    const trimmed = value.trim();
    if (isMaskedSecret(saved[key])) {
      if (trimmed !== '') patch[key] = trimmed;
    } else {
      patch[key] = trimmed;
    }
  }
  return patch;
}
