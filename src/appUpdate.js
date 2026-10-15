// Forced in-app update (1.10.16).
// On start (and when the app comes back to the front, at most every 30 min) the app asks GitHub
// for the latest release. When its version is newer than this APK and the release already carries
// the APK file, the whole app is replaced by an Update screen: the APK downloads inside the app and
// Android's installer opens. Offline / GitHub unreachable -> the app keeps working (never stuck on
// the round without internet).
import { Capacitor, registerPlugin } from '@capacitor/core';

export const REPO = 'rahulyadavoxo/dairy-diary';
export const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
export const CHECK_EVERY_MS = 30 * 60 * 1000;

const ApkUpdater = registerPlugin('ApkUpdater');

/** "1.10.16" -> [1,10,16]; anything else -> null. */
export function parseVer(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** <0 when a is older than b, 0 same, >0 newer. null if either is not a version. */
export function cmpVer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** From the GitHub "latest release" JSON: { version, url } once its APK is uploaded, else null. */
export function pickRelease(json) {
  if (!json || json.draft || json.prerelease) return null;
  const tag = String(json.tag_name || '');
  const p = parseVer(tag);
  if (!p) return null;
  const version = p.join('.');
  const name = `dairy-diary-v${version}.apk`;
  const asset = (json.assets || []).find((a) => a && a.name === name && a.state !== 'starter');
  if (!asset) return null;
  const url = `https://github.com/${REPO}/releases/download/v${version}/${name}`;
  return { version, url };
}

/** Version of the installed APK (versionName), or null on the web / when unknown. */
export async function installedVersion() {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    return info && parseVer(info.version) ? info.version : null;
  } catch {
    return null;
  }
}

/** { version, url } when a newer APK is available, null otherwise (or when it can't be known). */
export async function checkForUpdate({ current, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (!current || !fetchImpl) return null;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined,
    });
    if (!r || !r.ok) return null;
    const rel = pickRelease(await r.json());
    if (!rel) return null;
    const c = cmpVer(rel.version, current);
    return c !== null && c > 0 ? rel : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolves once every entry saved on this phone (also ones saved offline earlier) has reached
 * the server. The Update screen is shown only after this (user, 15 Oct 2026), so nothing is
 * left waiting on the phone when it updates. Never rejects.
 */
export async function waitForSync() {
  try {
    const { isFirebaseConfigured, getFirebase } = await import('./firebase.js');
    if (!isFirebaseConfigured()) return;
    const f = await getFirebase();
    await f.fsMod.waitForPendingWrites(f.db);
    // a second pass catches anything saved while the first batch was uploading
    await f.fsMod.waitForPendingWrites(f.db);
  } catch {
    /* Firestore unavailable / terminated: nothing to wait for */
  }
}

// ---- native bridge (wrapped: never hand the plugin proxy itself to await) ----

export async function downloadUpdate(url, onPercent) {
  let sub = null;
  try {
    if (onPercent) sub = await ApkUpdater.addListener('progress', (e) => onPercent(Number(e && e.percent) || 0));
  } catch {
    sub = null;
  }
  try {
    const r = await ApkUpdater.download({ url });
    return { size: r && r.size };
  } finally {
    if (sub && sub.remove) {
      try {
        await sub.remove();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function installUpdate() {
  const r = await ApkUpdater.install();
  return { started: !!(r && r.started), needsPermission: !!(r && r.needsPermission) };
}
