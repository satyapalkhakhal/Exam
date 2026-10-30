// shared/middleware/validate.ts
// Zod validation at the controller boundary. Parsed values replace the raw
// body/query/params so handlers only ever see typed, stripped input.

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
        Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true, enumerable: true });
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
