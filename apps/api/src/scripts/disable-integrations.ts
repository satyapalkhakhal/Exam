// scripts/disable-integrations.ts
// Break-glass: turns SMS and email delivery off without signing in (e.g. a
// provider is misbehaving, or the admin UI is unreachable). It edits only the
// `enabled` flag on the stored rows and never decrypts them, so it works even
// if CONFIG_ENCRYPTION_KEY is wrong or lost. Running APIs pick the change up
// within the 60 s config cache. With both channels off, OTPs fall back to the
// static code only where ALLOW_STATIC_OTP is on; otherwise sign-in OTPs stop.
// Usage: pnpm --filter @exam/api admin:disable-integrations

import { prisma } from '../infrastructure/db/prisma.js';
import { audit, type AuditRecord } from '../modules/audit/index.js';
import { EMAIL_KEY, SMS_KEY } from '../modules/messaging/index.js';
import { systemConfigRepository, type SystemConfigRepository } from '../modules/systemConfig/index.js';

export async function disableIntegrations(deps: {
  config: SystemConfigRepository;
  audit: (e: AuditRecord) => Promise<void>;
}): Promise<string[]> {
  const keys = [SMS_KEY, EMAIL_KEY];
  for (const key of keys) {
    const row = await deps.config.findByKey(key);
    const value = { ...((row?.value as Record<string, unknown> | undefined) ?? {}), enabled: false };
    await deps.config.upsert(key, value, null);
  }
  await deps.audit({ adminId: null, action: 'INTEGRATIONS_DISABLED_CLI', entity: 'system_config', metadata: { keys } });
  return keys;
}

async function main(): Promise<void> {
  const keys = await disableIntegrations({ config: systemConfigRepository, audit: audit.record });
  console.log(`Disabled: ${keys.join(', ')}. Running API instances apply this within 60 s.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err: unknown) => {
      console.error('disable-integrations failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
