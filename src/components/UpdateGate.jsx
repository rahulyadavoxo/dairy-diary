// Full-screen "Update" wall: shown when GitHub has a newer APK than the one installed.
// The app can't be used until the new APK is installed (user, 15 Oct 2026).
// Checked on start, on resume (1 min throttle), every 10 min while open, and when internet returns.
import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useLang } from '../i18n.js';
import { checkForUpdate, installedVersion, downloadUpdate, installUpdate, waitForSync, CHECK_EVERY_MS, POLL_WHILE_OPEN_MS } from '../appUpdate.js';

// A release this phone can never install (the native side refuses the file for good: versionCode
// not raised, other signing key, other app, not an APK). Blocking the app for it would lock the
// whole dairy forever, so that version is remembered and skipped; the next (fixed) release has a
// different version and is forced again normally.
export const SKIP_KEY = 'dd_upd_skip';
export const PERMANENT = ['NOT_NEWER', 'WRONG_SIGNER', 'WRONG_APP', 'NOT_APK', 'BAD_URL', 'NO_INSTALLER'];
const skipped = () => {
  try {
    return localStorage.getItem(SKIP_KEY) || '';
  } catch {
    return '';
  }
};
const skip = (v) => {
  try {
    localStorage.setItem(SKIP_KEY, v);
  } catch {
    /* private mode */
  }
};

const real = { check: checkForUpdate, current: installedVersion, download: downloadUpdate, install: installUpdate, sync: waitForSync };

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

  const run = async (force) => {
    if (!force && Date.now() - lastCheck.current < CHECK_EVERY_MS) return;
    lastCheck.current = Date.now();
    const current = await api.current();
    if (!current) return;
    setCur(current);
    const u = await api.check({ current });
    if (!u || u.version === skipped() || syncing.current) return;
    // First let this phone's saved entries reach the server, THEN lock the app for the update.
    // The app stays usable while that sync runs.
    syncing.current = true;
    try {
      await api.sync();
    } finally {
      syncing.current = false;
    }
    setUpd((old) => (old && old.version === u.version ? old : u));
  };

  const [rejected, setRejected] = useState(false);
  const updRef = useRef(upd); // install() also runs from the resume listener (old closure)
  updRef.current = upd;
  const giveUpIfPermanent = (e) => {
    const u = updRef.current;
    if (!u || !PERMANENT.includes(e && e.code)) return false;
    skip(u.version); // this release can never install here: stop blocking the app
    downloaded.current = null;
    setUpd(null);
    setStatus('idle');
    setRejected(true);
    setTimeout(() => setRejected(false), 8000);
    return true;
  };

  const install = async () => {
    try {
      setStatus('installing');
      const r = await api.install();
      setStatus(r.needsPermission ? 'perm' : 'installing');
    } catch (e) {
      console.error(e);
      if (giveUpIfPermanent(e)) return;
      downloaded.current = null; // file missing or rejected -> download again
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
          // back from Android's "allow installs" settings -> open the installer again
          if (statusRef.current === 'perm') install();
          else run(false);
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
      if (visible() && statusRef.current === 'idle') run(true).catch(() => {});
    }, pollMs);
    const onOnline = () => {
      if (visible()) run(true).catch(() => {});
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

  // The app stays MOUNTED under the wall (only hidden), so a register being filled when the
  // 10-minute check finds an update keeps what was typed (it was unmounted and lost before).
  const busy = status === 'downloading';
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
      {status === 'installing' && <p className="small">{t('updInstallHint')}</p>}
      {status === 'perm' && <p className="small">{t('updPermHint')}</p>}
      {status === 'error' && <p className="error small">{t('updFailed')}</p>}
      <button type="button" className="btn primary big" onClick={start} disabled={busy} data-testid="update-btn">
        {busy ? t('updDownloading') : status === 'error' ? t('updRetry') : '⬇️ ' + t('updNow')}
      </button>
      {/* No internet on the round: the download can't work, so let the app be used. The wall comes
          back by itself on the next check with internet (poll / internet back / app resume). */}
      {status === 'error' && offline && (
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
