// tests/spreadsheet.test.ts
// readSheet against the messy files HR actually sends: BOM + padded headers,
// Excel numeric cells, float noise, trailing blank rows and the size caps.

import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { readSheet } from '../src/shared/utils/spreadsheet.js';

async function xlsx(rows: (string | number | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('csv: BOM and padded mixed-case header are normalised', async () => {
  const buf = Buffer.from('﻿ Question_Text ,Max_Marks\n  hello there world ,5\n');
  const { headers, rows } = await readSheet(buf, 'q.csv');
  assert.deepEqual(headers, ['question_text', 'max_marks']);
  assert.deepEqual(rows, [{ question_text: 'hello there world', max_marks: '5' }]);
});

test('xlsx: a numeric cell comes back as an integer string', async () => {
  const { rows } = await readSheet(await xlsx([['roll'], [254101009]]), 'c.xlsx');
  assert.equal(rows[0]?.roll, '254101009');
});

test('xlsx: float noise is rounded to 6 significant digits', async () => {
  const { rows } = await readSheet(await xlsx([['score'], [97.6000001]]), 'c.xlsx');
  assert.equal(rows[0]?.score, '97.6');
});

test('xlsx: trailing empty rows are dropped', async () => {
  const { rows } = await readSheet(await xlsx([['a'], ['x'], [null], [null]]), 'c.xlsx');
  assert.equal(rows.length, 1);
});

test('csv: trailing empty lines are dropped', async () => {
  const { rows } = await readSheet(Buffer.from('a,b\n1,2\n,\n\n'), 'c.csv');
  assert.equal(rows.length, 1);
});

test('5,001 data rows are rejected, 5,000 pass', async () => {
  const body = (n: number) => 'a\n' + Array.from({ length: n }, (_, i) => `r${i}`).join('\n');
  assert.equal((await readSheet(Buffer.from(body(5000)), 'c.csv')).rows.length, 5000);
  await assert.rejects(readSheet(Buffer.from(body(5001)), 'c.csv'), { code: 'VALIDATION_ERROR' });
});

test('more than 50 columns is rejected', async () => {
  const header = Array.from({ length: 51 }, (_, i) => `c${i}`).join(',');
  await assert.rejects(readSheet(Buffer.from(header + '\n'), 'c.csv'), { code: 'VALIDATION_ERROR' });
});

test('other extensions are a 400', async () => {
  await assert.rejects(readSheet(Buffer.from('x'), 'c.pdf'), { statusCode: 400 });
});

test('rowNumbers: blank interior rows keep the source row (csv)', async () => {
  const { rows, rowNumbers } = await readSheet(Buffer.from('a\nx\n\n\ny\n'), 'c.csv');
  assert.equal(rows.length, 2);
  assert.deepEqual(rowNumbers, [2, 5]);
});

test('rowNumbers: blank interior rows keep the source row (xlsx)', async () => {
  const { rowNumbers } = await readSheet(await xlsx([['a'], ['x'], [null], [null], ['y']]), 'c.xlsx');
  assert.deepEqual(rowNumbers, [2, 5]);
});

interface FakeEntry {
  name: string;
  data: Buffer;
  declared: number;
}

/** Hand-built single-method(deflate) zip; `declared` lets a test lie in the central directory. */
async function zip(entries: FakeEntry[], opts: { eocdCount?: number; trailer?: Buffer } = {}): Promise<Buffer> {
  const { deflateRawSync } = await import('node:zlib');
  const locals: Buffer[] = [];
  const dirs: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const comp = deflateRawSync(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.declared, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, comp]);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(e.declared, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(off, 42);
    dirs.push(Buffer.concat([cd, name]));
    locals.push(local);
    off += local.length;
  }
  const dir = Buffer.concat(dirs);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(opts.eocdCount ?? entries.length, 8);
  end.writeUInt16LE(opts.eocdCount ?? entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, dir, end, opts.trailer ?? Buffer.alloc(0)]);
}

const MB5 = 5 * 1024 * 1024;
const zeros = Buffer.alloc(MB5);
const TOO_BIG = { code: 'VALIDATION_ERROR', message: 'File is too large when unpacked' };

test('xlsx zip bomb (honest sizes, high ratio) is rejected before unpacking', async () => {
  await assert.rejects(readSheet(await zip([{ name: 'a.xml', data: zeros, declared: MB5 }]), 'b.xlsx'), TOO_BIG);
});

test('bypass a: EOCD count lies, extra bomb entry in the directory', async () => {
  const buf = await zip(
    [
      { name: 'a.xml', data: Buffer.from('hi'), declared: 2 },
      { name: 'b.xml', data: zeros, declared: MB5 },
    ],
    { eocdCount: 1 },
  );
  await assert.rejects(readSheet(buf, 'b.xlsx'), { code: 'VALIDATION_ERROR', message: 'Invalid spreadsheet file' });
});

test('bypass b: fake EOCD in the trailing comment', async () => {
  const fake = Buffer.alloc(22);
  fake.writeUInt32LE(0x06054b50, 0);
  const buf = await zip([{ name: 'b.xml', data: zeros, declared: MB5 }], { trailer: fake });
  await assert.rejects(readSheet(buf, 'b.xlsx'), { code: 'VALIDATION_ERROR' });
});

test('bypass c: central directory lies about the uncompressed size', async () => {
  const buf = await zip([{ name: 'b.xml', data: zeros, declared: 100 }]);
  await assert.rejects(readSheet(buf, 'b.xlsx'), TOO_BIG);
});

test('a normal exceljs-written workbook still passes', async () => {
  const { rows } = await readSheet(await xlsx([['a'], ['x']]), 'c.xlsx');
  assert.equal(rows.length, 1);
});

test('bypass d: shifted fake EOCD hidden in the comment is refused', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const lh = (name: Buffer, comp: Buffer, decl: number) => {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(comp.length, 18);
    h.writeUInt32LE(decl, 22);
    h.writeUInt16LE(name.length, 26);
    return Buffer.concat([h, name, comp]);
  };
  const cd = (name: Buffer, comp: Buffer, decl: number, off: number) => {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(decl, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(off, 42);
    return Buffer.concat([c, name]);
  };
  const eocd = (size: number, off: number, cl: number) => {
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0);
    e.writeUInt16LE(1, 8);
    e.writeUInt16LE(1, 10);
    e.writeUInt32LE(size, 12);
    e.writeUInt32LE(off, 16);
    e.writeUInt16LE(cl, 20);
    return e;
  };
  const n = Buffer.from('a.xml');
  const b = Buffer.from('b.xml');
  const small = deflateRawSync(Buffer.from('hi'));
  const bomb = deflateRawSync(zeros);
  for (const extra of [1, 3, 10, 30]) {
    const l1 = lh(n, small, 2);
    const c1 = cd(n, small, 2, 0);
    const l2 = lh(b, bomb, MB5);
    const base = l1.length + c1.length + 22;
    const c2 = cd(b, bomb, MB5, base - extra);
    const comment = Buffer.concat([l2, c2, eocd(c2.length, base + l2.length - extra, 0)]);
    const buf = Buffer.concat([l1, c1, eocd(c1.length, l1.length, comment.length), comment]);
    await assert.rejects(readSheet(buf, 'b.xlsx'), { code: 'VALIDATION_ERROR' }, `extra=${extra}`);
  }
});
