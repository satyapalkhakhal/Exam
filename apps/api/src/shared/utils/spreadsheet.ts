// shared/utils/spreadsheet.ts
// One reader for every HR upload (questions, candidates): .csv via csv-parse,
// .xlsx via exceljs (first sheet). Output is always lower-cased, trimmed headers
// and string cells, so Excel quirks (numeric roll numbers, float noise like
// 97.6000001, BOM, blank trailing rows) are absorbed here once. Row and column
// caps bound the work a single upload can cause.

import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { badRequest } from '../errors.js';

export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 50;

export const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 100;
export const MAX_RATIO = 100;

export interface SheetData {
  headers: string[];
  rows: Record<string, string>[];
  /** rowNumbers[i] is the 1-based source row of rows[i]; the header is row 1. */
  rowNumbers: number[];
}

const TOO_BIG = 'File is too large when unpacked';

const BAD_ZIP = 'Invalid spreadsheet file';

interface ZipEntry {
  method: number;
  flags: number;
  comp: number;
  uncomp: number;
  localOffset: number;
}

/** Parses the central directory of the EOCD at `pos`; null unless it is structurally exact. */
function readDirectory(buf: Buffer, pos: number): ZipEntry[] | null {
  if (buf.length - (pos + 22) !== buf.readUInt16LE(pos + 20)) return null;
  const count = buf.readUInt16LE(pos + 10);
  const cdSize = buf.readUInt32LE(pos + 12);
  const cdOffset = buf.readUInt32LE(pos + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw badRequest(BAD_ZIP);
  if (cdOffset + cdSize !== pos) return null;
  const entries: ZipEntry[] = [];
  let off = cdOffset;
  for (let n = 0; n < count; n++) {
    if (off + 46 > pos || buf.readUInt32LE(off) !== 0x02014b50) return null;
    const e: ZipEntry = {
      flags: buf.readUInt16LE(off + 8),
      method: buf.readUInt16LE(off + 10),
      comp: buf.readUInt32LE(off + 20),
      uncomp: buf.readUInt32LE(off + 24),
      localOffset: buf.readUInt32LE(off + 42),
    };
    if (e.comp === 0xffffffff || e.uncomp === 0xffffffff || e.localOffset === 0xffffffff) throw badRequest(BAD_ZIP);
    entries.push(e);
    off += 46 + buf.readUInt16LE(off + 28) + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  if (off !== pos || (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x02014b50)) return null;
  return entries;
}

/**
 * Rejects zip bombs before exceljs inflates anything: the directory must be
 * structurally exact (so a lying count, fake EOCD or hidden entries cannot
 * hide data from this check but not from the reader), and every entry is
 * inflated here under a hard output cap and must match its declared size.
 */
export function assertSafeZip(buf: Buffer): void {
  const floor = Math.max(0, buf.length - 65_557);
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const last = buf.lastIndexOf(sig);
  // The reader (JSZip) trusts the LAST signature, so that is the only one validated; a second one
  // in the tail is how a hidden directory is smuggled in, so it is refused outright.
  if (last < floor || last + 22 > buf.length || buf.subarray(floor, last).includes(sig)) throw badRequest(BAD_ZIP);
  const entries = readDirectory(buf, last);
  if (!entries) throw badRequest(BAD_ZIP);
  if (entries.length > MAX_ZIP_ENTRIES) throw badRequest(TOO_BIG);

  let total = 0;
  for (const e of entries) {
    if (e.flags & 1 || (e.method !== 0 && e.method !== 8)) throw badRequest(BAD_ZIP);
    if (e.uncomp > MAX_UNPACKED_BYTES || e.uncomp > Math.max(e.comp, 1) * MAX_RATIO) throw badRequest(TOO_BIG);
    const lh = e.localOffset;
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) throw badRequest(BAD_ZIP);
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    if (start + e.comp > buf.length) throw badRequest(BAD_ZIP);
    const data = buf.subarray(start, start + e.comp);
    let size: number;
    if (e.method === 0) {
      size = data.length;
    } else {
      try {
        size = inflateRawSync(data, { maxOutputLength: Math.min(e.uncomp, MAX_UNPACKED_BYTES - total) + 1 }).length;
      } catch (err) {
        const code = (err as { code?: string }).code;
        throw badRequest(code === 'ERR_BUFFER_TOO_LARGE' ? TOO_BIG : BAD_ZIP);
      }
    }
    if (size !== e.uncomp && size > e.uncomp) throw badRequest(TOO_BIG);
    if (size !== e.uncomp) throw badRequest(BAD_ZIP);
    total += size;
    if (total > MAX_UNPACKED_BYTES) throw badRequest(TOO_BIG);
  }
}

function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)));
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString();
  if ('richText' in v) return v.richText.map((t) => t.text).join('').trim();
  if ('result' in v) return cellToString(v.result as ExcelJS.CellValue);
  if ('text' in v) return String(v.text).trim();
  return '';
}

interface Line {
  no: number;
  cells: string[];
}

function toSheet(lines: Line[]): SheetData {
  const head = lines[0]?.cells ?? [];
  if (head.length > MAX_COLUMNS) throw badRequest(`The file has more than ${MAX_COLUMNS} columns`);
  const headers = head.map((h) => h.trim().toLowerCase());
  const body = lines.slice(1).filter((l) => l.cells.some((c) => c.trim() !== ''));
  if (body.length > MAX_ROWS) throw badRequest(`The file has more than ${MAX_ROWS} rows`);
  const rows = body.map(({ cells: r }) => {
    const out: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h !== '' && !(h in out)) out[h] = (r[i] ?? '').trim();
    });
    return out;
  });
  return { headers: headers.filter((h) => h !== ''), rows, rowNumbers: body.map((l) => l.no) };
}

async function readXlsx(buffer: Buffer): Promise<Line[]> {
  assertSafeZip(buffer);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw badRequest('The file is not a readable .xlsx workbook');
  }
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const matrix: Line[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNo) => {
    if (matrix.length > MAX_ROWS + 1) return;
    const cells: string[] = [];
    const last = Math.min(row.cellCount, MAX_COLUMNS + 1);
    for (let c = 1; c <= last; c++) cells.push(cellToString(row.getCell(c).value));
    matrix.push({ no: rowNo, cells });
  });
  return matrix;
}

export async function readSheet(buffer: Buffer, fileName: string): Promise<SheetData> {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.csv') {
    try {
      const recs = parse(buffer, {
        bom: true,
        trim: true,
        skip_empty_lines: true,
        relax_column_count: true,
        info: true,
        raw: true,
      }) as { record: string[]; info: { lines: number }; raw: string }[];
      return toSheet(
        recs.map((r) => ({ no: r.info.lines - (r.raw.replace(/^(\r?\n)+/, '').replace(/\r?\n$/, '').split('\n').length - 1), cells: r.record })),
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AppError') throw err;
      throw badRequest('The file is not a valid CSV');
    }
  }
  if (ext === '.xlsx') return toSheet(await readXlsx(buffer));
  throw badRequest('Only .csv and .xlsx files are supported');
}
