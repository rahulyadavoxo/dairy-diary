import { lockNullPaneerRates } from './db.js';

export const PANEER_LOCK_KEY = 'dd_lockPaneer_v1';
export const PANEER_LOCK_FROM = '2026-10-01';

/** Money #1 one-time repair, guarded (NEW-3). Runs lockNullPaneerRates once per phone, and only when:
 *  - days, customers AND settings are loaded and each last came from the server (not a stale cache copy),
 *  - old history (before the live window) is on this phone (histOk), so no locked-able day is missing.
 *  A farm with no Settings paneer rate is skipped WITHOUT marking done: once a default rate is set the
 *  repair still runs (until then, null days have no default to freeze at).
 *  Returns 'wait' | 'skip' | 'done' | 'ran' (number of entries written in `n`). */
export function maybeLockPaneer({ fb, loaded, daysLive, customersLive, settingsLive, histOk, settings, customers, days }) {
  if (!loaded || !loaded.days || !loaded.customers || !loaded.settings) return { state: 'wait' };
  if (!daysLive || !customersLive || !settingsLive || histOk === false) return { state: 'wait' };
  if (!settings || !(Number(settings.paneerRatePaise) > 0)) return { state: 'skip' };
  try {
    if (localStorage.getItem(PANEER_LOCK_KEY)) return { state: 'done' };
    localStorage.setItem(PANEER_LOCK_KEY, String(Date.now()));
  } catch {
    return { state: 'skip' };
  }
  const n = lockNullPaneerRates(fb, customers, days, settings, PANEER_LOCK_FROM);
  return { state: 'ran', n };
}
