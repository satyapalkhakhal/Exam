// infrastructure/logger/logger.ts
// Winston JSON logger: console plus daily-rotating files under LOG_DIR. Callers
// must never pass OTPs, passwords, tokens, answer text or coordinates; mask
// emails/mobiles with piiMask first.

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { env } from '../config/env.js';

const { combine, timestamp, json, errors } = winston.format;
const jsonFormat = combine(errors({ stack: true }), timestamp(), json());

const transports: winston.transport[] = [new winston.transports.Console({ format: jsonFormat })];

if (env.NODE_ENV !== 'test') {
  const rotating = (dir: string, level?: string) =>
    new DailyRotateFile({
      dirname: `${env.LOG_DIR}/${dir}`,
      filename: `${dir}-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      maxSize: '100m',
      maxFiles: '30d',
      zippedArchive: true,
      format: jsonFormat,
      ...(level ? { level } : {}),
    });
  transports.push(rotating('combined'), rotating('error', 'error'));
}

export const logger = winston.createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  silent: env.NODE_ENV === 'test',
  transports,
});
