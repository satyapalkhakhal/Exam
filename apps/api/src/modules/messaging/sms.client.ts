// modules/messaging/sms.client.ts
// Posts one message to Arihant's SMS gateway over node:https (ported from the
// CRM's sms.client.ts). The body is an array-wrapped batch with one credential
// element and one message. NEVER logs the message body (it is the OTP), the
// token or an unmasked recipient. Callers gate on isChannelReady for `enabled`;
// this client only refuses when a required field is blank, so the admin "test"
// button works before the channel is switched on.

import https from 'node:https';
import { logger } from '../../infrastructure/logger/logger.js';
import { maskMobile } from '../../shared/utils/piiMask.js';
import { MessagingError } from './messaging.errors.js';
import { getSmsConfig, hasRequiredFields, type SmsConfig } from './messaging.config.js';

const REQUEST_TIMEOUT_MS = 15_000;

export interface SendSmsParams {
  /** 91 + 10-digit mobile. */
  to: string;
  message: string;
}

export async function sendSms({ to, message }: SendSmsParams, cfg?: SmsConfig): Promise<void> {
  const config = cfg ?? (await getSmsConfig());
  if (!hasRequiredFields(config)) throw new MessagingError('SMS gateway is not configured', 'NOT_CONFIGURED', false);

  // The token may be pasted bare or as the full "Basic <token>" value.
  const authorization = `Basic ${config.authToken.trim().replace(/^Basic\s+/i, '')}`;
  const url = new URL(config.baseUrl);
  const body = JSON.stringify([
    { UserName: config.userName, APIkey: config.apiKey, SMSType: 'OTP', messages: [{ To: to, msg: message }] },
  ]);

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
          Authorization: authorization,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', () => undefined);
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) return settle(resolve);
          logger.error('SMS gateway rejected the send request', { status, to: maskMobile(to) });
          settle(() =>
            reject(
              new MessagingError(`SMS gateway rejected the send request (${status})`, 'PROVIDER_REJECTED', status === 429 || status >= 500, status),
            ),
          );
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      logger.error('SMS gateway request timed out', { to: maskMobile(to) });
      settle(() => reject(new MessagingError('SMS gateway request timed out', 'TIMEOUT', true)));
      req.destroy();
    });
    req.on('error', (err) => {
      logger.error('SMS gateway request failed', { error: err.message, to: maskMobile(to) });
      settle(() => reject(new MessagingError('Could not reach the SMS gateway', 'REQUEST_FAILED', true)));
    });
    req.write(body);
    req.end();
  });
}
