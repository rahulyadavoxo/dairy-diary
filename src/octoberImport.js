// October 2026 register import. The transcribed data itself is real customer information, so it
// lives in src/octoberImport.local.js, which is gitignored and exists only on the build machine.
// Format there: export const OCT_IMPORT = { 'yyyy-mm-dd': { 'Name': litres | 'X' | '3P' | 'A+B' } }.
// Without that file the import screen is simply hidden.
const local = import.meta.glob('./octoberImport.local.js', { eager: true });
const mod = Object.values(local)[0];
export const OCT_IMPORT = (mod && mod.OCT_IMPORT) || {};


/** Parse a transcribed value into { milkL } or null (skip). */
export function parseImportValue(v) {
  if (v === 'X' || v == null || v === '') return null;
  if (typeof v === 'string' && v.includes('+')) {
    const [a, b] = v.split('+').map(Number);
    const m = Number.isFinite(a) ? a : 0;
    const e = Number.isFinite(b) ? b : 0;
    return { milkMorningL: m, milkEveningL: e, milkL: Math.round((m + e) * 1000) / 1000 };
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return { milkL: n };
}

export const IMPORT_DATES = Object.keys(OCT_IMPORT).sort();
