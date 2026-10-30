// shared/utils/clientInfo.ts
// Who is calling: IP (req.ip, which honours trust proxy) plus browser, OS and
// device class parsed from the User-Agent. Stored on login and location rows so
// HR can see what a candidate sat the exam on. The UA is capped before parsing
// so a hostile header cannot bloat a row or slow the parser.

import type { Request } from 'express';
import { UAParser } from 'ua-parser-js';

export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'unknown';

export interface ClientInfo {
  ip: string;
  userAgent: string;
  browser: string;
  os: string;
  deviceType: DeviceType;
}

const MAX_UA_LENGTH = 512;

export function clientInfo(req: Request): ClientInfo {
  const raw: unknown = req.headers['user-agent'];
  const userAgent = typeof raw === 'string' ? raw.slice(0, MAX_UA_LENGTH) : '';
  const parsed = new UAParser(userAgent).getResult();
  const type = parsed.device.type;
  const deviceType: DeviceType =
    type === 'mobile' ? 'mobile' : type === 'tablet' ? 'tablet' : parsed.os.name && parsed.browser.name ? 'desktop' : 'unknown';
  return {
    ip: req.ip ?? 'unknown',
    userAgent,
    browser: parsed.browser.name ?? 'Unknown',
    os: parsed.os.name ?? 'Unknown',
    deviceType,
  };
}
