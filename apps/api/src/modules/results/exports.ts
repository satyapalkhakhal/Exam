// modules/results/exports.ts
// The two Super Admin XLSX exports, streamed with exceljs so a large role never
// builds the whole file in memory. Every string cell goes through csvEscape
// (formula injection, design §13). Coordinates are never exported; location
// flags appear as plain-language findings.

import type { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import { csvEscape } from '../../shared/utils/csvEscape.js';

export type Cell = string | number | Date | null;

export interface SheetSpec {
  name: string;
  columns: { header: string; width?: number }[];
  rows: Cell[][];
}

const MAX_SHEET_NAME = 31;

/** Excel sheet names: ≤31 chars, none of []:*?/\ , unique within the book. */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = (raw.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim() || 'Sheet').slice(0, MAX_SHEET_NAME);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      const suffix = ` (${i})`;
      name = `${base.slice(0, MAX_SHEET_NAME - suffix.length)}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/** `results-<role>-<YYYY-MM-DD>.xlsx`, the date in India time. */
export function exportFileName(kind: 'results' | 'activity', roleName: string | null, at: Date): string {
  const slug = roleName ? roleName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'role' : 'all';
  const ist = new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return `${kind}-${slug}-${ist}.xlsx`;
}

export async function writeWorkbook(out: Writable, sheets: SheetSpec[]): Promise<void> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true });
  const names = sheetNames(sheets.map((s) => s.name));
  sheets.forEach((s, i) => {
    const ws = wb.addWorksheet(names[i]);
    ws.columns = s.columns.map((c) => ({ header: c.header, width: c.width ?? Math.max(12, c.header.length + 2) }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).commit();
    for (const row of s.rows) ws.addRow(row.map((v) => csvEscape(v))).commit();
    ws.commit();
  });
  await wb.commit();
}
