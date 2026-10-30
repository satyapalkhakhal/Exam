import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open } from '../src/infrastructure/crypto/secretBox.js';

test('seal/open round-trips and uses the v1 format', () => {
  const sealed = seal('s3cret-token');
  assert.match(sealed, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.equal(open(sealed), 's3cret-token');
});

test('two seals of the same text differ', () => {
  assert.notEqual(seal('same'), seal('same'));
});

test('tampering with any segment throws', () => {
  const [v, iv, tag, ct] = seal('hello world').split(':');
  const flip = (b64: string) => {
    const buf = Buffer.from(b64, 'base64');
    buf[0] = buf[0]! ^ 0xff;
    return buf.toString('base64');
  };
  assert.throws(() => open([v, flip(iv!), tag, ct].join(':')));
  assert.throws(() => open([v, iv, flip(tag!), ct].join(':')));
  assert.throws(() => open([v, iv, tag, flip(ct!)].join(':')));
  assert.throws(() => open(['v2', iv, tag, ct].join(':')));
  assert.throws(() => open('garbage'));
});
