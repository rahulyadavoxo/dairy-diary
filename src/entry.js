// Shared entry normalisation: raw register/delivery input -> Firestore entry.
// Keeps milkL (= total, what billing uses) in sync with the session split.
import { milkRateFor, paneerRateFor, toMilli } from './billing.js';

const q3 = (v) => Math.max(0, toMilli(v) / 1000);

export function normaliseEntry(customer, raw, settings) {
  const morn = q3(raw.milkMorningL);
  const eve = q3(raw.milkEveningL);
  // milkL is the source of truth for billing. The morning/evening split defines it only when
  // the split actually carries milk, or when no milkL was given at all. A stored "0 + 0" split
  // (total-mode / legacy entries) must NOT wipe an existing milkL when the row is re-saved.
  const hasMilkL = raw.milkL != null && raw.milkL !== '';
  const sessionsGiven = raw.milkMorningL != null || raw.milkEveningL != null;
  const hasSessions = sessionsGiven && (morn > 0 || eve > 0 || !hasMilkL);
  const total = hasSessions ? Math.round((morn + eve) * 1000) / 1000 : q3(raw.milkL);
  // Snapshot a rate only when one is actually set (> 0). null = "no rate yet": billing then uses
  // the customer / settings rate, so milk delivered before the rate was entered is not ₹0 forever.
  const mr = milkRateFor(customer, settings, null);
  const pr = paneerRateFor(settings, null, customer);
  return {
    milkL: total,
    milkMorningL: morn,
    milkEveningL: eve,
    paneerKg: q3(raw.paneerKg),
    skip: !!raw.skip,
    note: raw.note || '',
    milkRatePaise: mr > 0 ? mr : null,
    paneerRatePaise: pr > 0 ? pr : null,
  };
}

const round3 = (n) => Math.max(0, Math.round(Number(n || 0) * 1000) / 1000);
// Number(null) and Number('') are 0 (finite), so a null/empty field used to count as "set to 0"
// and the legacy usualL fallback was never used.
const isSet = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/** Usual morning litres for a customer (falls back to half of legacy usualL). */
export function usualMorning(c) {
  if (isSet(c.usualMorningL)) return round3(c.usualMorningL);
  return round3((Number(c.usualL) || 0) / 2);
}
/** Usual evening litres for a customer (falls back to half of legacy usualL). */
export function usualEvening(c) {
  if (isSet(c.usualEveningL)) return round3(c.usualEveningL);
  return round3((Number(c.usualL) || 0) / 2);
}
