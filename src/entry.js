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
  // Re-saving an existing entry keeps the rate it was billed at (raw carries the saved snapshot);
  // only a new entry (no valid snapshot) takes the customer / settings rate of today.
  const mr = milkRateFor(customer, settings, raw);
  const pr = paneerRateFor(settings, raw, customer);
  return {
    milkL: total,
    milkMorningL: morn,
    milkEveningL: eve,
    paneerKg: q3(raw.paneerKg),
    skip: !!raw.skip,
    note: raw.note || '',
    milkRatePaise: mr > 0 ? mr : null,
    paneerRatePaise: pr > 0 ? pr : null,
    // 'morning' = only the morning is recorded so far (evening still to come): the day is NOT
    // complete yet (Edit this day count, Delivery list). null = the whole day is recorded.
    half: raw.half === 'morning' || raw.half === 'evening' ? raw.half : null,
  };
}

const round3 = (n) => Math.max(0, Math.round(Number(n || 0) * 1000) / 1000);
// Number(null) and Number('') are 0 (finite), so a null/empty field used to count as "set to 0"
// and the legacy usualL fallback was never used.
const isSet = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/** Does this customer usually take milk both morning and evening? A customer who takes milk
    only once a day never has an "evening left" (user, 15 Oct 2026). */
export function takesTwice(c) {
  return !!c && usualMorning(c) > 0 && usualEvening(c) > 0;
}

/** Is this customer's day fully recorded? Morning + evening (or a total, or Absent / 0 L).
    A morning-only save from Delivery (half: 'morning') is not complete yet, unless the customer
    takes milk only once a day (pass the customer) and some milk was recorded. */
/** A morning-only save that recorded no milk and no paneer (morning 0, evening left empty).
    It means nothing was really filled: treated like no entry at all (user, 15 Oct 2026). */
export function emptyHalf(en) {
  return !!en && !!en.half && !en.skip &&
    (Number(en.milkMorningL) || 0) + (Number(en.milkEveningL) || 0) + (Number(en.milkL) || 0) <= 0 &&
    !((Number(en.paneerKg) || 0) > 0);
}

/** Show "Evening left" only for a twice-a-day customer whose morning milk is saved. */
export function eveningLeft(en, c) {
  return !!en && en.half === 'morning' && !emptyHalf(en) && !entryComplete(en, c);
}

export function entryComplete(en, c) {
  if (!en) return false;
  if (emptyHalf(en)) return false;
  if (!en.half) return true;
  if (c && !takesTwice(c)) return (Number(en.milkMorningL) || 0) + (Number(en.milkEveningL) || 0) + (Number(en.milkL) || 0) > 0;
  return false;
}

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
