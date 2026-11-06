// Full-screen "Update" wall: shown when GitHub has a newer APK than the one installed.
// The app can't be used until the new APK is installed (user, 15 Oct 2026).
// Checked on start, on resume (1 min throttle), every 10 min while open, and when internet returns.
// An update found by the 10-min check or internet-back is held until the next resume (or start),
// so it never jumps over half-typed work; start and resume lock at once.
import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useLang } from '../i18n.js';
import { setBackOwner } from '../backStack.js';
import { App as CapApp } from '@capacitor/app';
import { checkForUpdate, installedVersion, downloadUpdate, installUpdate, canInstallUpdate, waitForSync, CHECK_EVERY_MS, POLL_WHILE_OPEN_MS } from '../appUpdate.js';

// A release this phone can never install (the native side refuses the file for good: versionCode
// not raised, other signing key, other app, not an APK). Blocking the app for it would lock the
// whole dairy forever, so that version is remembered and skipped; the next (fixed) release has a
// different version and is forced again normally.
// The skip lasts SKIP_MS only: the same version may be re-uploaded fixed (CI --clobber), or the
// failure was a one-off, so it is tried again (forced) after 12 h. Stored as {"v", "at"}.
export const SKIP_KEY = 'dd_upd_skip';
export const SKIP_MS = 12 * 60 * 60 * 1000;
export const PERMANENT = ['NOT_NEWER', 'WRONG_SIGNER', 'WRONG_APP', 'NOT_APK', 'BAD_URL', 'NO_INSTALLER'];
// NOT_APK can also be a broken download: give up on a version only after the 2nd NOT_APK.
const NOT_APK_TRIES = 2;
// "Use the app now" after this many failed tries even with a network (weak signal, wifi without
// internet: Android still says online).
const FAILS_FOR_LATER = 2;
const skipped = () => {
  try {
    const s = JSON.parse(localStorage.getItem(SKIP_KEY) || 'null');
    return s && typeof s === 'object' && s.v && Date.now() - Number(s.at) < SKIP_MS ? s.v : '';
  } catch {
    return ''; // old plain-string value (no time) -> expired; rewritten on the next skip
  }
};
const skip = (v) => {
  try {
    localStorage.setItem(SKIP_KEY, JSON.stringify({ v, at: Date.now() }));
  } catch {
    /* private mode */
  }
};

const real = { check: checkForUpdate, current: installedVersion, download: downloadUpdate, install: installUpdate, canInstall: canInstallUpdate, sync: waitForSync };
// v1.10.73: "Use the app now" after this many installer runs that came back without an update
// (Android's "App not installed": storage full, signature mismatch it can't report back).
const INSTALLS_FOR_LATER = 2;

export default function UpdateGate({ children, api = real, native = Capacitor.isNativePlatform(), pollMs = POLL_WHILE_OPEN_MS }) {
  const { t } = useLang();
  const [cur, setCur] = useState(null);
  const [upd, setUpd] = useState(null); // { version, url }
  const [status, setStatus] = useState('idle'); // idle | downloading | installing | perm | error
  const [pct, setPct] = useState(0);
  const lastCheck = useRef(0);
  const downloaded = useRef(null); // version already downloaded
  const syncing = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;
  const [fails, setFails] = useState(0); // failed download/install tries for the shown version
  const notApk = useRef({ v: null, n: 0 });
  // An update found by the 10-min poll or internet-back while the app is in use waits here for
  // the next resume (app back to the front) instead of jumping over half-typed work.
  const queued = useRef(null);

  // defer = found while the app is in use (poll / online): queue it unless the wall is already up
  const run = async (force, defer = false) => {
    if (!force && Date.now() - lastCheck.current < CHECK_EVERY_MS) return;
    lastCheck.current = Date.now();
    const current = await api.current();
    if (!current) return;
    setCur(current);
    // held update (poll found it earlier): still lock on resume even if this check can't reach GitHub
    const u = (await api.check({ current })) || (defer ? null : queued.current);
    if (!u || u.version === skipped() || syncing.current) return;
    if (defer && !updRef.current) {
      queued.current = u;
      return;
    }
    queued.current = null;
    // First let this phone's saved entries reach the server, THEN lock the app for the update.
    // The app stays usable while that sync runs.
    syncing.current = true;
    try {
      await api.sync();
    } finally {
      syncing.current = false;
    }
    const old = updRef.current;
    if (!old || old.version !== u.version) {
      setFails(0);
      setUpd(u);
    }
  };

  const [rejected, setRejected] = useState(false);
  const updRef = useRef(upd); // install() also runs from the resume listener (old closure)
  updRef.current = upd;
  const giveUpIfPermanent = (e) => {
    const u = updRef.current;
    if (!u || !PERMANENT.includes(e && e.code)) return false;
    if (e.code === 'NOT_APK') {
      if (notApk.current.v !== u.version) notApk.current = { v: u.version, n: 0 };
      if (++notApk.current.n < NOT_APK_TRIES) return false; // maybe a broken download: normal Retry
    }
    skip(u.version); // this release can never install here: stop blocking the app
    downloaded.current = null;
    setUpd(null);
    setStatus('idle');
    setRejected(true);
    setTimeout(() => setRejected(false), 8000);
    return true;
  };

  // installer runs / returns without the permission, per version (escape hatches below)
  const [tries, setTries] = useState({ v: null, installs: 0, permBacks: 0 });
  const bump = (key) =>
    setTries((x) => {
      const v = updRef.current ? updRef.current.version : null;
      const base = x.v === v ? x : { v, installs: 0, permBacks: 0 };
      return { ...base, [key]: base[key] + 1 };
    });
  const install = async () => {
    try {
      setStatus('installing');
      const r = await api.install();
      if (!r.needsPermission && r.started !== false) bump('installs');
      setStatus(r.needsPermission ? 'perm' : 'installing');
    } catch (e) {
      console.error(e);
      if (giveUpIfPermanent(e)) return;
      downloaded.current = null; // file missing or rejected -> download again
      setFails((n) => n + 1);
      setStatus('error');
    }
  };

  const start = async () => {
    if (!upd || statusRef.current === 'downloading') return;
    if (downloaded.current === upd.version) return install();
    setPct(-1); // -1 = connecting (no bytes yet); the first chunk reports 0
    setStatus('downloading');
    try {
      await api.download(upd.url, setPct);
      downloaded.current = upd.version;
    } catch (e) {
      console.error(e);
      if (giveUpIfPermanent(e)) return;
      setFails((n) => n + 1);
      setStatus('error');
      return;
    }
    install();
  };

  useEffect(() => {
    if (!native) return undefined;
    run(true).catch(() => {});
    let sub = null;
    let alive = true;
    import('@capacitor/app')
      .then(({ App }) =>
        App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) return;
          // back from Android's "allow installs" settings: only CHECK. Open the installer when it is
          // allowed now; otherwise stay on the wall with the hint (Settings opens again only when
          // the user taps Update; re-opening it on every resume trapped the Back button).
          if (statusRef.current === 'perm') {
            const can = api.canInstall ? api.canInstall() : Promise.resolve(true);
            Promise.resolve(can)
              .then((ok) => {
                if (statusRef.current !== 'perm') return;
                if (ok) install();
                else bump('permBacks');
              })
              .catch(() => {});
          }
          else if (queued.current) run(true).catch(() => {}); // update held from the poll: lock now
          else run(false).catch(() => {});
        }),
      )
      .then((s) => {
        if (alive) sub = s;
        else if (s && s.remove) s.remove();
      })
      .catch(() => {});
    // App open and in use: check again every few minutes, and as soon as internet comes back.
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const tick = setInterval(() => {
      if (visible() && statusRef.current === 'idle') run(true, true).catch(() => {});
    }, pollMs);
    const onOnline = () => {
      if (visible()) run(true, true).catch(() => {});
    };
    window.addEventListener('online', onOnline);
    return () => {
      alive = false;
      clearInterval(tick);
      window.removeEventListener('online', onOnline);
      if (sub && sub.remove) sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  // While the wall is up it owns the Android Back button: the app hidden underneath must not
  // close a form / open a popup / switch tab. Back just sends the app to the background.
  const shown = !!upd;
  useEffect(() => {
    if (!shown) return undefined;
    return setBackOwner(() => {
      try {
        Promise.resolve(CapApp.minimizeApp()).catch(() => {});
      } catch {
        /* web: nothing to minimise */
      }
    });
  }, [shown]);

  // The app stays MOUNTED under the wall (only hidden), so a register being filled when the
  // 10-minute check finds an update keeps what was typed (it was unmounted and lost before).
  const busy = status === 'downloading';
  const triesNow = upd && tries.v === upd.version ? tries : { installs: 0, permBacks: 0 };
  const installStuck = status === 'installing' && triesNow.installs >= INSTALLS_FOR_LATER;
  const permStuck = status === 'perm' && triesNow.permBacks >= 1;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const wall = upd && (
    <div className="center-screen update-gate" data-testid="update-gate">
      <div className="update-icon" aria-hidden="true">
        ⬆️
      </div>
      <h2>{t('updTitle')}</h2>
      <p>{t('updBody').replace('{v}', upd.version)}</p>
      {cur && <p className="muted small">{t('updCurrent').replace('{v}', cur)}</p>}
      {busy && (
        <div className="upd-progress" aria-label={t('updDownloading')}>
          <div className="upd-bar" style={{ width: Math.max(pct, 0) + '%' }} />
        </div>
      )}
      {busy && <p className="small" data-testid="update-pct">{pct < 0 ? t('updConnecting') : t('updDownloading') + ' ' + pct + '%'}</p>}
      {status === 'installing' && <p className="small">{t(installStuck ? 'updInstallFailedHint' : 'updInstallHint')}</p>}
      {status === 'perm' && <p className="small">{t('updPermHint')}</p>}
      {status === 'error' && <p className="error small">{t('updFailed')}</p>}
      <button type="button" className="btn primary big" onClick={start} disabled={busy} data-testid="update-btn">
        {busy ? t('updDownloading') : status === 'error' ? t('updRetry') : '⬇️ ' + t('updNow')}
      </button>
      {/* No (usable) internet on the round: offline, or 2 failed tries (weak signal / wifi without
          internet still counts as online). Let the app be used; the wall comes back by itself on
          the next check (poll / internet back / app resume), so the update is still forced. */}
      {((status === 'error' && (offline || fails >= FAILS_FOR_LATER)) || installStuck || permStuck) && (
        <button
          type="button"
          className="btn big"
          data-testid="update-later"
          onClick={() => {
            setUpd(null);
            setStatus('idle');
          }}
        >
          {t('updLater')}
        </button>
      )}
    </div>
  );
  return (
    <>
      <div style={{ display: upd ? 'none' : 'contents' }} data-testid="update-gate-app">
        {children}
      </div>
      {rejected && (
        <div className="offline-bar" role="status" data-testid="update-rejected">
          {t('updRejected')}
        </div>
      )}
      {wall}
    </>
  );
}
