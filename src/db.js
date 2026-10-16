// Firestore data layer.
import { deleteCachedPhoto } from './billCache.js';
import { vibrateFail } from './feedback.js';
//
// All data lives under farms/{farmId}/ (see src/devices.js and firestore.rules); fb.farmId is
// set once this phone is an authorized device of the farm. Paths below are relative to it:
//   settings/main            { milkRatePaise, paneerRatePaise, farmName, phone }
//   customers/{id}           { name, phone, area, usualL, rateOverridePaise|null, openingDuePaise,
//                              order, active, pauseFrom, pauseTo, createdAt, updatedAt }
//   days/{yyyy-mm-dd}        { date, lastEditedBy, lastEditedAt,
//                              entries: { [customerId]: { milkL, paneerKg, skip, note,
//                                         milkRatePaise, paneerRatePaise, updatedBy, updatedAt } } }
//                            -> one document per day; each entry is addressed by date + customer.
//                               Writes use merge so the two phones never overwrite each other's
//                               rows for the same day, and a whole month is only ~30 reads.
//   payments/{id}            { customerId, date, amountPaise, mode: 'cash'|'upi', note, createdBy, createdAt }

/** Farm-scoped refs: farms/{farmId}/{coll}[/{id}] */
function fdoc(fb, coll, id) {
  if (!fb.farmId) throw new Error('farmId missing');
  return fb.fsMod.doc(fb.db, 'farms', fb.farmId, coll, id);
}
function fcol(fb, coll) {
  if (!fb.farmId) throw new Error('farmId missing');
  return fb.fsMod.collection(fb.db, 'farms', fb.farmId, coll);
}

export function listenAll(fb, handlers) {
  const { onSnapshot } = fb.fsMod;
  const unsubs = [];
  const opts = { includeMetadataChanges: true };

  unsubs.push(
    onSnapshot(fdoc(fb, 'settings', 'main'), opts, (s) => handlers.settings(s.exists() ? s.data() : {}), handlers.error),
  );
  unsubs.push(
    onSnapshot(fcol(fb, 'customers'), opts, (qs) => {
      handlers.customers(qs.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, handlers.error),
  );
  unsubs.push(
    onSnapshot(fcol(fb, 'days'), opts, (qs) => {
      const days = {};
      const pending = {};
      qs.docs.forEach((d) => {
        days[d.id] = d.data();
        if (d.metadata.hasPendingWrites) pending[d.id] = true;
      });
      handlers.days(days, pending, qs.metadata.fromCache);
    }, handlers.error),
  );
  unsubs.push(
    onSnapshot(fcol(fb, 'payments'), opts, (qs) => {
      handlers.payments(qs.docs.map((d) => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites })));
    }, handlers.error),
  );
  return () => unsubs.forEach((u) => u());
}

// NOTE: we never `await` writes in the UI. With offline persistence, a write is applied to the
// local cache instantly and the promise only resolves once the server confirms, which never
// happens while offline. Errors are logged.
// A write the server refused (rules, removed phone...) vibrates once so it is not silent.
const log = (p) =>
  p.catch((e) => {
    console.error('[firestore]', e);
    vibrateFail();
  });

export function saveSettings(fb, data) {
  const { fsMod } = fb;
  return log(fsMod.setDoc(fdoc(fb, 'settings', 'main'), data, { merge: true }));
}

export function saveCustomer(fb, id, data) {
  const { fsMod } = fb;
  const { doc, setDoc } = fsMod;
  const ref = id ? fdoc(fb, 'customers', id) : doc(fcol(fb, 'customers'));
  const payload = { ...data, updatedAt: Date.now() };
  if (!id) payload.createdAt = Date.now();
  log(setDoc(ref, payload, { merge: true }));
  return ref.id;
}

/** Re-number route order for the given ordered list of customer ids (only writes changed ones). */
export function saveOrder(fb, orderedCustomers) {
  const { db, fsMod } = fb;
  const batch = fsMod.writeBatch(db);
  let n = 0;
  orderedCustomers.forEach((c, i) => {
    const order = (i + 1) * 10;
    if (c.order !== order) {
      batch.update(fdoc(fb, 'customers', c.id), { order });
      n++;
    }
  });
  if (n) log(batch.commit());
}

const emptyVal = (v) => v == null || v === 0 || v === '' || v === false;
const sameVal = (a, b) => Object.is(a, b) || (emptyVal(a) && emptyVal(b));

/** Only the fields of `next` that differ from `base` (the entry the editor started from).
 *  undefined / null / 0 / '' / false count as the same "empty" value. */
export function entryChanges(base, next) {
  const out = {};
  for (const k of Object.keys(next || {})) if (!sameVal((base || {})[k], next[k])) out[k] = next[k];
  // A brand-new entry always carries milkL, so a 0 L day is stored as milkL: 0 (user, 16 Oct 2026).
  if (!base && next && 'milkL' in next) out.milkL = next.milkL;
  return out;
}

/** Save several register rows for one date. rows: { [customerId]: entry }
 *  bases (optional): { [customerId]: entry as it was when the user started editing }. When given,
 *  only the fields the user actually changed are written, so two phones (or a phone that was
 *  offline) editing different fields of the same customer's day don't overwrite each other. */
export function saveEntries(fb, date, rows, editorName, bases) {
  const { fsMod } = fb;
  const now = Date.now();
  const entries = {};
  for (const [cid, e] of Object.entries(rows)) {
    const part = bases ? entryChanges(bases[cid], e) : e;
    // Nothing changed for an entry that already exists: skip it. But a NEW all-zero entry
    // (0 L / didn't take) must still be created - "entry exists, no milk" is what shows the ✕
    // in the calendar and counts the customer as filled for the day (lock, Edit this day).
    if (bases && !Object.keys(part).length && bases[cid]) continue;
    entries[cid] = { ...part, updatedBy: editorName, updatedAt: now };
  }
  if (!Object.keys(entries).length) return Promise.resolve();
  rows = entries;
  // Invalidate cached bill photos for this month (they'll regenerate)
  const month = date.slice(0, 7);
  for (const cid of Object.keys(rows)) deleteCachedPhoto(cid, month);
  return log(
    fsMod.setDoc(
      fdoc(fb, 'days', date),
      { date, entries, lastEditedBy: editorName, lastEditedAt: now },
      { merge: true },
    ),
  );
}

export function addPayment(fb, p) {
  const { fsMod } = fb;
  const ref = fsMod.doc(fcol(fb, 'payments'));
  if (p.customerId && p.date) deleteCachedPhoto(p.customerId, p.date.slice(0, 7));
  log(fsMod.setDoc(ref, { ...p, createdAt: Date.now() }));
  return ref.id;
}

export function deletePayment(fb, id, payment) {
  const { fsMod } = fb;
  if (payment && payment.customerId && payment.date) deleteCachedPhoto(payment.customerId, payment.date.slice(0, 7));
  return log(fsMod.deleteDoc(fdoc(fb, 'payments', id)));
}

/** Delete one customer's entry for a date (removes it from the day's entries map). */
// Not awaited by the UI (same reason as saveEntries: offline the promise never resolves).
export function deleteEntry(fb, date, customerId, editorName) {
  const { fsMod } = fb;
  const now = Date.now();
  deleteCachedPhoto(customerId, date.slice(0, 7));
  // updateDoc (not setDoc+merge) is the reliable way to delete a nested field
  return log(
    fsMod.updateDoc(fdoc(fb, 'days', date), {
      [`entries.${customerId}`]: fsMod.deleteField(),
      lastEditedBy: editorName,
      lastEditedAt: now,
    }),
  );
}
