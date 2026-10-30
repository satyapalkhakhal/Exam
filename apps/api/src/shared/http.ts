// shared/http.ts
// Success half of the response envelope.

import type { Response } from 'express';

export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({ success: true, data });
}
