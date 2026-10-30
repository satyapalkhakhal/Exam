import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../src/shared/middleware/errorHandler.js';
import { AppError } from '../src/shared/errors.js';

function appThrowing(err: Error) {
  const app = express();
  app.get('/boom', () => {
    throw err;
  });
  app.use(errorHandler);
  return app;
}

test('AppError maps to its status and the standard body', async () => {
  const res = await request(appThrowing(new AppError(409, 'CONFLICT', 'x'))).get('/boom');
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { success: false, error: { message: 'x', code: 'CONFLICT' } });
});

test('unknown errors become a generic 500 with no stack', async () => {
  const res = await request(appThrowing(new Error('db down'))).get('/boom');
  assert.equal(res.status, 500);
  assert.equal(res.body.error.message, 'Internal server error');
  assert.equal(res.body.error.code, 'INTERNAL_ERROR');
  assert.equal('stack' in res.body, false);
  assert.equal('stack' in res.body.error, false);
});
