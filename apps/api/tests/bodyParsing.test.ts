import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';

test('malformed JSON is a 400 in the standard error shape', async () => {
  const res = await request(createApp())
    .post('/api/anything')
    .set('Content-Type', 'application/json')
    .send('{"a":');
  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  assert.equal(typeof res.body.error.message, 'string');
  assert.equal('stack' in res.body.error, false);
});

test('body over 256kb is a 413', async () => {
  const res = await request(createApp())
    .post('/api/anything')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ a: 'x'.repeat(300 * 1024) }));
  assert.equal(res.status, 413);
  assert.equal(res.body.error.code, 'PAYLOAD_TOO_LARGE');
});

test('unsupported charset keeps its 415 status', async () => {
  const res = await request(createApp())
    .post('/api/anything')
    .set('Content-Type', 'application/json; charset=latin-9')
    .send('{"a":1}');
  assert.equal(res.status, 415);
  assert.equal(res.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
});
