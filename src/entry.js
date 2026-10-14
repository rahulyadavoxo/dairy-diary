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
  return {
    milkL: total,
    milkMorningL: morn,
    milkEveningL: eve,
    paneerKg: q3(raw.paneerKg),
    skip: !!raw.skip,
    note: raw.note || '',
    milkRatePaise: milkRateFor(customer, settings, null),
    paneerRatePaise: paneerRateFor(settings, null),
  };
}

/** Build an "as usual" entry for a customer (usual morning/evening quantities). */
export function usualEntry(customer, settings, usualMorning, usualEvening) {
  return normaliseEntry(
    customer,
    { milkMorningL: usualMorning, milkEveningL: usualEvening, paneerKg: 0, skip: false, note: '' },
    settings,
  );
}
