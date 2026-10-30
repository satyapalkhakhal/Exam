// shared/utils/csvEscape.ts
// Formula-injection guard for exports (design §13). A cell a spreadsheet would
// read as a formula (= + - @, or a leading tab/CR) gets a leading apostrophe so
// it is shown as text. Applied to every string cell an export writes;
// non-strings pass through untouched.

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvEscape<T>(v: T): T | string {
  return typeof v === 'string' && FORMULA_START.test(v) ? `'${v}` : v;
}
