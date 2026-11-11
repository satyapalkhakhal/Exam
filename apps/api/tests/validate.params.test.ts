// validate(): parsed params replace the raw ones. With two param validators in one
// route (application id, then application + question id) the first must not drop
// the params it does not know, or every per-question save is refused (400).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { validate } from '../src/shared/middleware/validate.js';

const run = (mw: ReturnType<typeof validate>, req: Request) =>
  new Promise<unknown>((resolve) => mw(req, {} as Response, ((err?: unknown) => resolve(err)) as NextFunction));

test('a params validator keeps params it does not declare, so a later validator still sees them', async () => {
  const appId = '11111111-1111-4111-8111-111111111111';
  const qId = '22222222-2222-4222-8222-222222222222';
  const req = { params: { applicationId: appId, attemptQuestionId: qId }, body: {}, query: {} } as unknown as Request;
  const first = validate({ params: z.object({ applicationId: z.string().uuid() }) });
  const second = validate({ params: z.object({ applicationId: z.string().uuid(), attemptQuestionId: z.string().uuid() }) });
  assert.equal(await run(first, req), undefined);
  assert.equal(await run(second, req), undefined, 'second validator must pass');
  assert.deepEqual(req.params, { applicationId: appId, attemptQuestionId: qId });
});

test('body is still replaced by the parsed (stripped) value', async () => {
  const req = { params: {}, body: { a: 1, extra: 'x' }, query: {} } as unknown as Request;
  assert.equal(await run(validate({ body: z.object({ a: z.number() }) }), req), undefined);
  assert.deepEqual(req.body, { a: 1 });
});
