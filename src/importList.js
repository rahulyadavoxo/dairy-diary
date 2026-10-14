// Bulk customer import: paste names (one per line), optionally with quantities
// as "Name, morning, evening".
// The pre-filled list is real customer information, so it lives in src/importList.local.js
// (gitignored, build machine only): export const DEFAULT_IMPORT_LIST = `Name\nName…`.
// Without that file the box simply starts empty.
const local = import.meta.glob('./importList.local.js', { eager: true });
const mod = Object.values(local)[0];
export const DEFAULT_IMPORT_LIST = (mod && typeof mod.DEFAULT_IMPORT_LIST === 'string' && mod.DEFAULT_IMPORT_LIST) || '';


/** Parse import text into [{ name, morningL, eveningL, bad? }]. Keeps every line (repeats are
    removed by freshImports). bad = a quantity was typed but is not a number >= 0. */
export function parseImportList(text) {
  const out = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/[,|]/).map((s) => s.trim());
    const name = parts[0];
    if (!name) continue;
    // Empty / missing field -> default 0.5 (Number('') is 0, which silently set 0 L).
    const num = (v) => (v === undefined || v === '' ? NaN : Number(v));
    const m = num(parts[1]);
    const e = num(parts[2]);
    const isBad = (raw, n) => raw !== undefined && raw !== '' && !(Number.isFinite(n) && n >= 0);
    const row = {
      name,
      morningL: Number.isFinite(m) && m >= 0 ? Math.round(m * 1000) / 1000 : 0.5,
      eveningL: Number.isFinite(e) && e >= 0 ? Math.round(e * 1000) / 1000 : 0.5,
    };
    if (isBad(parts[1], m) || isBad(parts[2], e)) row.bad = true;
    out.push(row);
  }
  return out;
}

const key = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Lines to add: not already a customer and not a repeat within the paste (case-insensitive). */
export function freshImports(parsed, customers = []) {
  const seen = new Set(customers.map((c) => key(c.name)));
  const out = [];
  for (const p of parsed) {
    const k = key(p.name);
    if (p.bad || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}
