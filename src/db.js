// Firestore data layer.
import { deleteCachedPhoto } from './billCache.js';
import { vibrateFail } from './feedback.js';
import { addMonths, todayISO } from './format.js';
import { trackWrite } from './pendingSync.js';
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
//   settings/history         { v, at }  bumped on every write to a date before liveCutoff()

/** Farm-scoped refs: farms/{farmId}/{coll}[/{id}] */
function fdoc(fb, coll, id) {
  if (!fb.farmId) throw new Error('farmId missing');
  return fb.fsMod.doc(fb.db, 'farms', fb.farmId, coll, id);
}
function fcol(fb, coll) {
  if (!fb.farmId) throw new Error('farmId missing');
  return fb.fsMod.collection(fb.db, 'farms', fb.farmId, coll);
}

// ---------------------------------------------------------------- live window + old history
// Free Firestore allows 50,000 reads a day, and a listener that reconnects after 30 min is
// billed like a fresh query. Listening to EVERY day and payment ever made would read the whole
// history on each app open and cross that limit in a year or two. So (v1.10.42):
//   * days and payments from the last LIVE_MONTHS months (this month included) are listened live;
//   * everything older is read ONCE and then served from this phone's offline cache;
//   * settings/history { v } is a counter that every write to an old date bumps. When it changes
//     (another phone edited an old record), the old part is read from the server again.
// The screens still receive the full, merged history, so every balance stays exactly the same.
export const LIVE_MONTHS = 3;

/** First date that is listened live: the 1st of the month LIVE_MONTHS-1 months back. */
export function liveCutoff(today = todayISO()) {
  return `${addMonths(today.slice(0, 7), -(LIVE_MONTHS - 1))}-01`;
}

export const HIST_KEY = 'dd_hist_v1';
function readHistMark(farmId) {
  try {
    const m = JSON.parse(localStorage.getItem(HIST_KEY) || 'null');
    return m && m.farmId === farmId ? m : null;
  } catch {
    return null;
  }
}
function writeHistMark(mark) {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(mark));
  } catch {
    /* private mode */
  }
}

/** Bump the old-history counter after a write to a date before the live window. */
function touchHistory(fb, date) {
  const { fsMod } = fb;
  if (!date || date >= liveCutoff() || !fsMod.increment) return;
  log(fsMod.setDoc(fdoc(fb, 'settings', 'history'), { v: fsMod.increment(1), at: Date.now() }, { merge: true }));
}

export function listenAll(fb, handlers) {
  const { onSnapshot } = fb.fsMod;
  const fs = fb.fsMod;
  const unsubs = [];
  const opts = { includeMetadataChanges: true };
  const cutoff = liveCutoff();
  const windowed = !!(fs.query && fs.where && fs.documentId && fs.getDocs);
  let stopped = false;

  // live part
  let liveDays = null; // null until the first snapshot
  let livePending = {};
  let liveFromCache = true;
  let livePays = null;
  // old part (before cutoff)
  let oldDays = {};
  let oldPays = [];
  let oldReady = !windowed;

  const emitDays = () => {
    if (stopped || liveDays === null || !oldReady) return;
    handlers.days({ ...oldDays, ...liveDays }, livePending, liveFromCache);
  };
  const emitPays = () => {
    if (stopped || livePays === null || !oldReady) return;
    handlers.payments([...oldPays, ...livePays]);
  };

  unsubs.push(
    onSnapshot(fdoc(fb, 'settings', 'main'), opts, (s) => handlers.settings(s.exists() ? s.data() : {}), handlers.error),
  );
  unsubs.push(
    onSnapshot(fcol(fb, 'customers'), opts, (qs) => {
      handlers.customers(qs.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, handlers.error),
  );

  const daysQ = windowed ? fs.query(fcol(fb, 'days'), fs.where(fs.documentId(), '>=', cutoff)) : fcol(fb, 'days');
  const paysQ = windowed ? fs.query(fcol(fb, 'payments'), fs.where('date', '>=', cutoff)) : fcol(fb, 'payments');
  unsubs.push(
    onSnapshot(daysQ, opts, (qs) => {
      const days = {};
      const pending = {};
      qs.docs.forEach((d) => {
        days[d.id] = d.data();
        if (d.metadata.hasPendingWrites) pending[d.id] = true;
      });
      liveDays = days;
      livePending = pending;
      liveFromCache = qs.metadata.fromCache;
      emitDays();
    }, handlers.error),
  );
  unsubs.push(
    onSnapshot(paysQ, opts, (qs) => {
      livePays = qs.docs.map((d) => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites }));
      emitPays();
    }, handlers.error),
  );

  if (windowed) {
    const oldDaysQ = fs.query(fcol(fb, 'days'), fs.where(fs.documentId(), '<', cutoff));
    const oldPaysQ = fs.query(fcol(fb, 'payments'), fs.where('date', '<', cutoff));
    const take = (dq, pq) => {
      oldDays = {};
      dq.docs.forEach((d) => {
        oldDays[d.id] = d.data();
      });
      oldPays = pq.docs.map((d) => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites }));
      oldReady = true;
      emitDays();
      emitPays();
    };
    const fromCache = async () => {
      if (!fs.getDocsFromCache) throw new Error('no cache api');
      const [dq, pq] = await Promise.all([fs.getDocsFromCache(oldDaysQ), fs.getDocsFromCache(oldPaysQ)]);
      return [dq, pq];
    };
    let serverFor = null; // history version already read from the server in this session
    let busy = Promise.resolve();
    const loadOld = (v, confirmed) => {
      busy = busy.then(async () => {
        if (stopped) return;
        const mark = readHistMark(fb.farmId);
        let cacheOk = false;
        // 1) Instant: this phone's cache (also shows this phone's own unsynced old edits).
        try {
          const [dq, pq] = await fromCache();
          if (!stopped) take(dq, pq);
          // the cache must still hold everything the last server read had (not wiped/evicted)
          cacheOk = !!mark && dq.docs.length >= (mark.nd || 0) && pq.docs.length >= (mark.np || 0);
        } catch {
          /* no cache yet */
        }
        const sameAsSaved = cacheOk && mark.v === v && mark.cutoff === cutoff;
        // 2) Server, only when the old part may differ from what this phone has.
        if (!confirmed || sameAsSaved || serverFor === v) {
          if (!oldReady) take({ docs: [] }, { docs: [] });
          return;
        }
        try {
          const [dq, pq] = await Promise.all([fs.getDocs(oldDaysQ), fs.getDocs(oldPaysQ)]);
          if (stopped) return;
          take(dq, pq);
          if (!dq.metadata || !dq.metadata.fromCache) {
            serverFor = v;
            writeHistMark({ farmId: fb.farmId, v, cutoff, nd: dq.docs.length, np: pq.docs.length });
          }
        } catch (e) {
          console.error('[history]', e); // offline: keep the cached copy, retry on the next change
          if (!oldReady) take({ docs: [] }, { docs: [] });
        }
      });
    };
    unsubs.push(
      onSnapshot(fdoc(fb, 'settings', 'history'), opts, (s) => {
        const v = (s.exists() && s.data().v) || 0;
        // confirmed = the server has answered (not just this phone's cache or its own pending write)
        loadOld(v, !s.metadata.fromCache && !s.metadata.hasPendingWrites);
      }, (e) => {
        handlers.error(e);
        loadOld(-1, true); // can't watch the counter: read the old part from the server once
      }),
    );
  }
  return () => {
    stopped = true;
    unsubs.forEach((u) => u());
  };
}

// NOTE: we never `await` writes in the UI. With offline persistence, a write is applied to the
// local cache instantly and the promise only resolves once the server confirms, which never
// happens while offline. Errors are logged.
// A write the server refused (rules, removed phone...) vibrates once so it is not silent.
const log = (p) =>
  trackWrite(p).catch((e) => {
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
  const done = log(
    fsMod.setDoc(
      fdoc(fb, 'days', date),
      { date, entries, lastEditedBy: editorName, lastEditedAt: now },
      { merge: true },
    ),
  );
  touchHistory(fb, date);
  return done;
}

export function addPayment(fb, p) {
  const { fsMod } = fb;
  const ref = fsMod.doc(fcol(fb, 'payments'));
  if (p.customerId && p.date) deleteCachedPhoto(p.customerId, p.date.slice(0, 7));
  log(fsMod.setDoc(ref, { ...p, createdAt: Date.now() }));
  touchHistory(fb, p.date);
  return ref.id;
}

export function deletePayment(fb, id, payment) {
  const { fsMod } = fb;
  if (payment && payment.customerId && payment.date) deleteCachedPhoto(payment.customerId, payment.date.slice(0, 7));
  const done = log(fsMod.deleteDoc(fdoc(fb, 'payments', id)));
  if (payment) touchHistory(fb, payment.date);
  return done;
}

/** Delete one customer's entry for a date (removes it from the day's entries map). */
// Not awaited by the UI (same reason as saveEntries: offline the promise never resolves).
export function deleteEntry(fb, date, customerId, editorName) {
  const { fsMod } = fb;
  const now = Date.now();
  deleteCachedPhoto(customerId, date.slice(0, 7));
  // updateDoc (not setDoc+merge) is the reliable way to delete a nested field
  const done = log(
    fsMod.updateDoc(fdoc(fb, 'days', date), {
      [`entries.${customerId}`]: fsMod.deleteField(),
      lastEditedBy: editorName,
      lastEditedAt: now,
    }),
  );
  touchHistory(fb, date);
  return done;
}
