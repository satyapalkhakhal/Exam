// modules/integrations/integrations.service.ts
// Settings -> Integrations logic. Secrets leave this service only as
// {set,last4}; a secret omitted/null on PUT keeps the stored value. Every save
// and test-send is audited (never with secrets or recipients). The audit writer
// and the senders are injected: the audit module arrives in Task 5.

import type {
  AiConfigInput,
  EmailConfigInput,
  IntegrationsView,
  MaskedAiConfig,
  MaskedEmailConfig,
  MaskedSecret,
  MaskedSmsConfig,
  SmsConfigInput,
} from '@exam/shared';
import { AppError, badRequest } from '../../shared/errors.js';
import type { SystemConfigService } from '../systemConfig/index.js';
import { MessagingError } from '../messaging/messaging.errors.js';
import {
  EMAIL_KEY,
  SMS_KEY,
  mergeEmail,
  mergeSms,
  type EmailConfig,
  type SmsConfig,
} from '../messaging/messaging.config.js';
import type { SendSmsParams } from '../messaging/sms.client.js';
import type { SendEmailParams } from '../messaging/email.client.js';
import { AI_KEY, AiProviderError, mergeAi, type AiConfig } from '../aiEvaluation/index.js';

export interface AuditEntry {
  adminId: string;
  action: string;
  entity: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export interface IntegrationsDeps {
  config: Pick<SystemConfigService, 'getConfig' | 'setConfig'>;
  audit: (entry: AuditEntry) => Promise<void>;
  sendSms: (p: SendSmsParams) => Promise<void>;
  sendEmail: (p: SendEmailParams) => Promise<void>;
  /** One tiny structured call with the saved AI key and model; throws AiProviderError on provider failure. */
  testAi: () => Promise<{ model: string }>;
  /** Candidates with no mobile can only receive OTPs by email; shown beside the SMS card. */
  countCandidatesWithoutMobile: () => Promise<number>;
}

const mask = (v: string): MaskedSecret =>
  v.trim() === '' ? { set: false, last4: null } : { set: true, last4: v.length >= 8 ? v.slice(-4) : null };

// Pointing a channel at a new host must come with fresh secrets; the stored
// ones are never replayed to a host the admin has just typed.
const REENTER = 'Re-enter the credentials when changing the base URL';
function assertSecretsFresh(urlChanged: boolean, fresh: (string | null | undefined)[]): void {
  if (urlChanged && fresh.some((s) => !s)) throw badRequest(REENTER);
}

const keep = (incoming: string | null | undefined, current: string): string =>
  incoming && incoming.trim() !== '' ? incoming : current;

export function createIntegrationsService(deps: IntegrationsDeps) {
  const loadSms = async (): Promise<SmsConfig> => mergeSms(await deps.config.getConfig<Partial<SmsConfig>>(SMS_KEY));
  const loadEmail = async (): Promise<EmailConfig> => mergeEmail(await deps.config.getConfig<Partial<EmailConfig>>(EMAIL_KEY));

  const loadAi = async (): Promise<AiConfig> => mergeAi(await deps.config.getConfig<Partial<AiConfig>>(AI_KEY));

  const maskAi = (c: AiConfig): MaskedAiConfig => ({
    enabled: c.enabled,
    apiKey: mask(c.apiKey),
    model: c.model,
    concurrency: c.concurrency,
    gradingInstructions: c.gradingInstructions,
  });

  const maskSms = (c: SmsConfig): MaskedSmsConfig => ({
    enabled: c.enabled,
    baseUrl: c.baseUrl,
    authToken: mask(c.authToken),
    userName: c.userName,
    apiKey: mask(c.apiKey),
    otpTemplate: c.otpTemplate,
  });
  const maskEmailCfg = (c: EmailConfig): MaskedEmailConfig => ({
    enabled: c.enabled,
    baseUrl: c.baseUrl,
    sendMailToken: mask(c.sendMailToken),
    fromAddress: c.fromAddress,
    fromName: c.fromName,
    replyTo: c.replyTo,
    ccAddresses: c.ccAddresses,
  });

  async function get(): Promise<IntegrationsView & { candidatesWithoutMobile: number }> {
    return {
      sms: maskSms(await loadSms()),
      email: maskEmailCfg(await loadEmail()),
      ai: maskAi(await loadAi()),
      candidatesWithoutMobile: await deps.countCandidatesWithoutMobile(),
    };
  }

  async function updateSms(input: SmsConfigInput, adminId: string): Promise<MaskedSmsConfig> {
    const current = await loadSms();
    assertSecretsFresh(input.baseUrl !== current.baseUrl, [input.authToken, input.apiKey]);
    const next: SmsConfig = {
      enabled: input.enabled,
      baseUrl: input.baseUrl,
      authToken: keep(input.authToken, current.authToken),
      userName: input.userName,
      apiKey: keep(input.apiKey, current.apiKey),
      otpTemplate: input.otpTemplate,
    };
    await deps.config.setConfig(SMS_KEY, { ...next }, adminId);
    await deps.audit({
      adminId,
      action: 'INTEGRATION_SMS_UPDATED',
      entity: 'system_config',
      entityId: SMS_KEY,
      metadata: { enabled: next.enabled, authTokenChanged: !!input.authToken, apiKeyChanged: !!input.apiKey },
    });
    return maskSms(next);
  }

  async function updateEmail(input: EmailConfigInput, adminId: string): Promise<MaskedEmailConfig> {
    const current = await loadEmail();
    assertSecretsFresh(input.baseUrl !== current.baseUrl, [input.sendMailToken]);
    const next: EmailConfig = {
      enabled: input.enabled,
      baseUrl: input.baseUrl,
      sendMailToken: keep(input.sendMailToken, current.sendMailToken),
      fromAddress: input.fromAddress,
      fromName: input.fromName,
      replyTo: input.replyTo,
      ccAddresses: input.ccAddresses ?? '',
    };
    await deps.config.setConfig(EMAIL_KEY, { ...next }, adminId);
    await deps.audit({
      adminId,
      action: 'INTEGRATION_EMAIL_UPDATED',
      entity: 'system_config',
      entityId: EMAIL_KEY,
      metadata: { enabled: next.enabled, tokenChanged: !!input.sendMailToken },
    });
    return maskEmailCfg(next);
  }

  async function updateAi(input: AiConfigInput, adminId: string): Promise<MaskedAiConfig> {
    const current = await loadAi();
    const next: AiConfig = {
      enabled: input.enabled,
      apiKey: input.apiKey === '' ? '' : keep(input.apiKey, current.apiKey),
      model: input.model,
      concurrency: input.concurrency ?? current.concurrency,
      gradingInstructions: input.gradingInstructions ?? '',
    };
    await deps.config.setConfig(AI_KEY, { ...next }, adminId);
    await deps.audit({
      adminId,
      action: 'INTEGRATION_AI_UPDATED',
      entity: 'system_config',
      entityId: AI_KEY,
      metadata: {
        enabled: next.enabled,
        model: next.model,
        concurrency: next.concurrency,
        apiKeyChanged: input.apiKey !== undefined && input.apiKey !== null,
        instructionsLength: next.gradingInstructions.length,
      },
    });
    return maskAi(next);
  }

  // Provider failures surface as 502 with the provider's own message; the
  // attempt is audited either way, with the outcome but not the recipient.
  async function deliver(action: string, entityId: string, adminId: string, send: () => Promise<void>) {
    try {
      await send();
    } catch (err) {
      await deps.audit({ adminId, action, entity: 'system_config', entityId, metadata: { delivered: false } });
      if (err instanceof MessagingError || err instanceof AiProviderError) throw new AppError(502, 'BAD_GATEWAY', err.message);
      throw err;
    }
    await deps.audit({ adminId, action, entity: 'system_config', entityId, metadata: { delivered: true } });
    return { delivered: true as const };
  }

  async function testSms(mobile: string, adminId: string) {
    const cfg = await loadSms();
    return deliver('INTEGRATION_SMS_TESTED', SMS_KEY, adminId, () =>
      deps.sendSms({ to: `91${mobile}`, message: cfg.otpTemplate.replace('{otp}', '000000') }),
    );
  }

  async function testEmail(email: string, adminId: string) {
    return deliver('INTEGRATION_EMAIL_TESTED', EMAIL_KEY, adminId, () =>
      deps.sendEmail({
        to: email,
        subject: 'Arihant Recruitment Assessment: email test',
        html: '<p>This is a test email from the Arihant Recruitment Assessment platform.</p>',
        text: 'This is a test email from the Arihant Recruitment Assessment platform.',
      }),
    );
  }

  async function testAi(adminId: string) {
    return deliver('INTEGRATION_AI_TESTED', AI_KEY, adminId, async () => {
      await deps.testAi();
    });
  }

  return { get, updateSms, updateEmail, updateAi, testSms, testEmail, testAi };
}

export type IntegrationsService = ReturnType<typeof createIntegrationsService>;
