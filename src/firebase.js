import { firebaseConfig } from './firebaseConfig.js';

const REQUIRED = ['apiKey', 'authDomain', 'projectId', 'appId'];

/** True only when every required key has a real-looking value (not a PASTE_/YOUR_ placeholder). */
export function isFirebaseConfigured(cfg = firebaseConfig) {
  if (!cfg || typeof cfg !== 'object') return false;
  return REQUIRED.every((k) => {
    const v = cfg[k];
    if (typeof v !== 'string' || v.trim().length < 4) return false;
    return !/PASTE|YOUR_|REPLACE|XXXX|<.*>/i.test(v);
  });
}

let cached = null;

/** Lazily initialise Firebase (only called once config is real). */
// One shared init even when two callers ask at once (App start + the update check).
let initing = null;
export function getFirebase() {
  if (cached) return Promise.resolve(cached);
  if (!initing) {
    initing = initFirebase().catch((e) => {
      initing = null;
      throw e;
    });
  }
  return initing;
}

// Offline save broken: Firestore could not open its on-disk cache (phone storage full, IndexedDB
// failing) and keeps writes in memory only. Entries saved without internet are then lost when the
// app is closed, so the app shows a warning bar (App.jsx listens for the 'dd-memcache' event).
let memOnly = false;
export const MEMCACHE_EVENT = 'dd-memcache';
export const offlineSaveBroken = () => memOnly;
export function markMemCache() {
  if (memOnly) return;
  memOnly = true;
  try {
    window.dispatchEvent(new Event(MEMCACHE_EVENT));
  } catch {
    /* no window (tests) */
  }
}
/** Firebase log line that says Firestore fell back from IndexedDB to memory. */
export const isMemFallbackLog = (e) => /Falling back to memory cache/i.test(String((e && e.message) || ''));

async function initFirebase() {
  if (cached) return cached;
  const [appMod, authMod, fsMod] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('firebase/firestore'),
  ]);
  const { initializeApp, onLog } = appMod;
  // Firebase 12 falls back to a memory cache with only a console warning; catch that warning.
  try {
    if (onLog) onLog((e) => isMemFallbackLog(e) && markMemCache(), { level: 'warn' });
  } catch {
    /* logging hook unavailable */
  }
  const app = initializeApp(firebaseConfig);
  // initializeAuth + IndexedDB persistence: works in the Android WebView and keeps users signed in.
  let auth;
  try {
    auth = authMod.initializeAuth(app, {
      persistence: [authMod.indexedDBLocalPersistence, authMod.browserLocalPersistence],
    });
  } catch {
    auth = authMod.getAuth(app);
  }
  // Offline-first Firestore: everything is cached in IndexedDB, writes queue while offline.
  let db;
  try {
    db = fsMod.initializeFirestore(app, {
      localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentSingleTabManager() }),
    });
  } catch {
    db = fsMod.getFirestore(app); // memory-only cache
    markMemCache();
  }
  cached = { app, auth, db, authMod, fsMod };
  return cached;
}
