// shared/middleware/validate.ts
// Zod validation at the controller boundary. Parsed values replace the raw
// body/query so handlers only ever see typed, stripped input; params are merged.

import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny } from 'zod';
import { badRequest } from '../errors.js';

export interface ZodSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export function validate(schemas: ZodSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const issues: { path: string; message: string }[] = [];
    for (const part of ['body', 'query', 'params'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        // Params are merged, not replaced: a route may validate them in two steps
        // (application id, then application + question id), and the first step must
        // not drop the params it does not declare. Body and query stay stripped.
        const value = part === 'params' ? { ...(req.params as object), ...(result.data as object) } : result.data;
        Object.defineProperty(req, part, { value, writable: true, configurable: true, enumerable: true });
      } else {
        for (const i of result.error.issues) {
          issues.push({ path: [part, ...i.path].join('.'), message: i.message });
        }
      }
    }
    if (issues.length > 0) {
      next(badRequest('Validation failed', 'VALIDATION_ERROR', issues));
      return;
    }
    next();
  };
}
