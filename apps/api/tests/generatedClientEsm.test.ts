// C1 guard: the production image runs the compiled API as native Node ESM, which
// never adds ".js" to an extensionless relative import. tsx (dev and every other
// test) does, so only this check and the Dockerfile boot smoke catch a generated
// Prisma client that would crash `node dist/index.js` on boot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/generated/prisma');
const SPECIFIER = /^\s*(?:import|export)\b[^'"]*from\s+['"](\.\.?\/[^'"]+)['"]/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test('C1: every relative import in the generated Prisma client carries a .js extension', () => {
  const all = files(root);
  assert.ok(all.length > 0, 'generated client present (run prisma generate)');
  const bad: string[] = [];
  for (const f of all) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = SPECIFIER.exec(line);
      if (m && !m[1]!.endsWith('.js')) bad.push(`${path.relative(root, f)}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});
