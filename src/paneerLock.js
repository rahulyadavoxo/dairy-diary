import { lockNullPaneerRates } from './db.js';

export const PANEER_LOCK_KEY = 'dd_lockPaneer_v1';
export const PANEER_LOCK_FROM = '2026-10-01';

/** The "done" key is per farm: a phone that ran the repair for farm A and later joins farm B must
 *  still run it for B. */
export const paneerLockKey = (fb) => `${PANEER_LOCK_KEY}_${(fb && fb.farmId) || ''}`;

// Farms whose repair batches are written but not yet confirmed (memory only): the effect re-runs on
// every days / customers change and must not write the same batches again meanwhile.
const running = new Set();
export function resetPaneerLockForTests() {
  running.clear();
}

/** Money #1 one-time repair, guarded (NEW-3). Runs lockNullPaneerRates once per farm on this phone,
 *  and only when:
 *  - days, customers AND settings are loaded and each last came from the server (not a stale cache copy),
 *  - old history (before the live window) is on this phone (histOk), so no locked-able day is missing.
 *  A farm with no Settings paneer rate is skipped WITHOUT marking done: once a default rate is set the
 *  repair still runs (until then, null days have no default to freeze at).
 *  The done key is written only AFTER every batch write has resolved (a failed / never-confirmed
 *  write leaves it unset, so the repair runs again on a later start).
 *  Returns 'wait' | 'skip' | 'done' | 'running' | 'ran' (entries written in `n`, `done` = promise
 *  that resolves true once the key is saved, false when a write failed). */
export function maybeLockPaneer({ fb, loaded, daysLive, customersLive, settingsLive, histOk, settings, customers, days }) {
  if (!loaded || !loaded.days || !loaded.customers || !loaded.settings) return { state: 'wait' };
  if (!daysLive || !customersLive || !settingsLive || histOk === false) return { state: 'wait' };
  if (!settings || !(Number(settings.paneerRatePaise) > 0)) return { state: 'skip' };
  const key = paneerLockKey(fb);
  try {
    if (localStorage.getItem(key)) return { state: 'done' };
  } catch {
    return { state: 'skip' };
  }
  if (running.has(key)) return { state: 'running' };
  running.add(key);
  const commits = [];
  let n;
  try {
    n = lockNullPaneerRates(fb, customers, days, settings, PANEER_LOCK_FROM, commits);
  } catch (e) {
    running.delete(key);
    console.error('[paneerLock]', e);
    return { state: 'skip' };
  }
  const done = Promise.all(commits).then(
    () => {
      try {
        localStorage.setItem(key, String(Date.now()));
      } catch {
        /* ignore */
      }
      running.delete(key);
      return true;
    },
    () => {
      running.delete(key); // not marked done: tried again on a later run
      return false;
    },
  );
  return { state: 'ran', n, done };
}
