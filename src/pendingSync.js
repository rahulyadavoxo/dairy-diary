// Background upload (v1.10.49).
// Every Firestore write promise resolves only when the server confirms it, so counting the
// unresolved ones tells us whether anything is still waiting to upload. The native SyncKeeper
// plugin gets a simple pending true/false; while pending and in the background it keeps the
// app process alive so the Firebase SDK uploads by itself once the internet is back.
import { Capacitor, registerPlugin } from '@capacitor/core';

const SyncKeeper = registerPlugin('SyncKeeper');
let n = 0;
let last = false;

function report() {
  const p = n > 0;
  if (p === last) return;
  last = p;
  // Never throw from here: a missing/mocked plugin must not break a write.
  try {
    if (Capacitor.isNativePlatform() && typeof SyncKeeper.setPending === 'function') {
      Promise.resolve(SyncKeeper.setPending({ pending: p })).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

/** Count a write until the server confirms (or refuses) it. Returns the same promise. */
export function trackWrite(p) {
  n++;
  report();
  const done = () => {
    n = Math.max(0, n - 1);
    report();
  };
  Promise.resolve(p).then(done, done);
  return p;
}

export const pendingCount = () => n;

/** Writes queued before the app was closed are re-sent by the SDK on start: track them too. */
export function initPendingSync(fb) {
  try {
    trackWrite(fb.fsMod.waitForPendingWrites(fb.db));
  } catch {
    /* ignore */
  }
}

export function _resetPendingSync() {
  n = 0;
  last = false;
}
