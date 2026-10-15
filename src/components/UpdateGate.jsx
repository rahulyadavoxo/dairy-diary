// Full-screen "Update" wall: shown when GitHub has a newer APK than the one installed.
// The app can't be used until the new APK is installed (user, 15 Oct 2026).
import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useLang } from '../i18n.js';
import { checkForUpdate, installedVersion, downloadUpdate, installUpdate, CHECK_EVERY_MS } from '../appUpdate.js';

const real = { check: checkForUpdate, current: installedVersion, download: downloadUpdate, install: installUpdate };

export default function UpdateGate({ children, api = real, native = Capacitor.isNativePlatform() }) {
  const { t } = useLang();
  const [cur, setCur] = useState(null);
  const [upd, setUpd] = useState(null); // { version, url }
  const [status, setStatus] = useState('idle'); // idle | downloading | installing | perm | error
  const [pct, setPct] = useState(0);
  const lastCheck = useRef(0);
  const downloaded = useRef(null); // version already downloaded
  const statusRef = useRef(status);
  statusRef.current = status;

  const run = async (force) => {
    if (!force && Date.now() - lastCheck.current < CHECK_EVERY_MS) return;
    lastCheck.current = Date.now();
    const current = await api.current();
    if (!current) return;
    setCur(current);
    const u = await api.check({ current });
    if (u) setUpd((old) => (old && old.version === u.version ? old : u));
  };

  const install = async () => {
    try {
      setStatus('installing');
      const r = await api.install();
      setStatus(r.needsPermission ? 'perm' : 'installing');
    } catch (e) {
      console.error(e);
      downloaded.current = null; // file missing or rejected -> download again
      setStatus('error');
    }
  };

  const start = async () => {
    if (!upd || statusRef.current === 'downloading') return;
    if (downloaded.current === upd.version) return install();
    setPct(0);
    setStatus('downloading');
    try {
      await api.download(upd.url, setPct);
      downloaded.current = upd.version;
    } catch (e) {
      console.error(e);
      setStatus('error');
      return;
    }
    install();
  };

  useEffect(() => {
    if (!native) return undefined;
    run(true);
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
    return () => {
      alive = false;
      if (sub && sub.remove) sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  if (!upd) return children;

  const busy = status === 'downloading';
  return (
    <div className="center-screen update-gate" data-testid="update-gate">
      <div className="update-icon" aria-hidden="true">
        ⬆️
      </div>
      <h2>{t('updTitle')}</h2>
      <p>{t('updBody').replace('{v}', upd.version)}</p>
      {cur && <p className="muted small">{t('updCurrent').replace('{v}', cur)}</p>}
      {busy && (
        <div className="upd-progress" aria-label={t('updDownloading')}>
          <div className="upd-bar" style={{ width: pct + '%' }} />
        </div>
      )}
      {busy && <p className="small">{t('updDownloading') + ' ' + pct + '%'}</p>}
      {status === 'installing' && <p className="small">{t('updInstallHint')}</p>}
      {status === 'perm' && <p className="small">{t('updPermHint')}</p>}
      {status === 'error' && <p className="error small">{t('updFailed')}</p>}
      <button type="button" className="btn primary big" onClick={start} disabled={busy} data-testid="update-btn">
        {busy ? t('updDownloading') : status === 'error' ? t('updRetry') : '⬇️ ' + t('updNow')}
      </button>
    </div>
  );
}
