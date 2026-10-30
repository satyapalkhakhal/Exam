// modules/messaging/email.client.ts
// Sends one email through ZatpatMail's POST /v1.1/email over node:https (ported
// from the CRM's email.client.ts). Auth is `C-enczapikey <token>`, added when
// the pasted token lacks the scheme. Open/click tracking is off. NEVER logs the
// payload or token; the recipient is masked. Like sendSms, it refuses only when
// a required field is blank, leaving the `enabled` gate to callers.

import https from 'node:https';
import { logger } from '../../infrastructure/logger/logger.js';
import { maskEmail } from '../../shared/utils/piiMask.js';
import { MessagingError } from './messaging.errors.js';
import { getEmailConfig, hasRequiredFields, type EmailConfig } from './messaging.config.js';

const REQUEST_TIMEOUT_MS = 15_000;
const SEND_PATH = '/v1.1/email';
const AUTH_SCHEME = 'C-enczapikey';

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Accepts the token with or without the scheme prefix. */
export function buildAuthHeader(token: string): string {
  const trimmed = token.trim();
  return /\s/.test(trimmed) ? trimmed : `${AUTH_SCHEME} ${trimmed}`;
}

// ZatpatMail sends `error.details` as an object (docs) or an array (ZeptoMail).
function extractProviderError(body: string): { code: string; message: string } | null {
  try {
    const error = (JSON.parse(body) as { error?: { code?: string; message?: string; details?: unknown } }).error;
    if (!error) return null;
    const first = Array.isArray(error.details) ? error.details[0] : error.details;
    const detail = first && typeof first === 'object' ? (first as { code?: string; message?: string }) : undefined;
    return {
      code: String(detail?.code ?? error.code ?? 'PROVIDER_REJECTED'),
      message: String(detail?.message ?? error.message ?? 'ZatpatMail rejected the request'),
    };
  } catch {
    return null;
  }
}

export async function sendEmail({ to, subject, html, text }: SendEmailParams, cfg?: EmailConfig): Promise<void> {
  const config = cfg ?? (await getEmailConfig());
  if (!hasRequiredFields(config)) throw new MessagingError('Email provider is not configured', 'NOT_CONFIGURED', false);

  const url = new URL(config.baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${SEND_PATH}`;
  const payload = JSON.stringify({
    from: config.fromName ? { address: config.fromAddress, name: config.fromName } : { address: config.fromAddress },
    to: [{ email_address: { address: to } }],
    ...(config.replyTo ? { reply_to: [{ address: config.replyTo }] } : {}),
    subject,
    htmlbody: html,
    textbody: text,
    track_opens: false,
    track_clicks: false,
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: buildAuthHeader(config.sendMailToken),
        },
      },
      (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (responseBody += chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) return settle(resolve);
          const provider = extractProviderError(responseBody);
          const code = provider?.code ?? 'PROVIDER_REJECTED';
          logger.error('ZatpatMail rejected the send request', { to: maskEmail(to), status, code });
          settle(() =>
            reject(
              new MessagingError(provider?.message ?? `ZatpatMail rejected the request (${status})`, code, status === 429 || status >= 500, status),
            ),
          );
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      logger.error('ZatpatMail request timed out', { to: maskEmail(to) });
      settle(() => reject(new MessagingError('ZatpatMail request timed out', 'TIMEOUT', true)));
      req.destroy();
    });
    req.on('error', (err) => {
      logger.error('ZatpatMail request failed', { to: maskEmail(to), error: err.message });
      settle(() => reject(new MessagingError('Could not reach ZatpatMail', 'REQUEST_FAILED', true)));
    });
    req.write(payload);
    req.end();
  });
}
