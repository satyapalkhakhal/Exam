// index.ts
// Process entry: starts the HTTP server, the auto-submit worker and the minute
// sweep (design §7.6), and shuts them down cleanly on SIGTERM/SIGINT.

import { app } from './app.js';
import { env } from './infrastructure/config/env.js';
import { logger } from './infrastructure/logger/logger.js';
import { STATIC_OTP_BANNER, otpPosture } from './infrastructure/config/bootChecks.js';
import { getEmailConfig, getSmsConfig, isChannelReady } from './modules/messaging/index.js';
import { closeAutoSubmitQueue } from './infrastructure/queue/autoSubmit.queue.js';
import { startAutoSubmitWorker } from './infrastructure/queue/autoSubmit.worker.js';
import { startSweep } from './infrastructure/queue/sweep.js';

const server = app.listen(env.PORT, () => {
  logger.info('api listening', { port: env.PORT });
});
// OTP posture at boot: channel state plus, in production, the static-OTP
// banner. A config read failure must not stop the server, only this log.
Promise.all([getSmsConfig(), getEmailConfig()])
  .then(([sms, email]) => {
    for (const line of otpPosture({
      nodeEnv: env.NODE_ENV,
      allowStatic: env.ALLOW_STATIC_OTP,
      smsReady: isChannelReady(sms),
      emailReady: isChannelReady(email),
    })) {
      logger[line.level](line.message, line.meta ?? {});
    }
  })
  .catch((err: unknown) => {
    logger.error('could not read OTP channel config at boot', { message: err instanceof Error ? err.message : 'unknown' });
    if (env.ALLOW_STATIC_OTP && env.NODE_ENV === 'production') logger.warn(STATIC_OTP_BANNER);
  });

const worker = startAutoSubmitWorker();
const sweep = startSweep();

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  clearInterval(sweep);
  server.close(() => {
    Promise.allSettled([worker.close(), closeAutoSubmitQueue()]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
