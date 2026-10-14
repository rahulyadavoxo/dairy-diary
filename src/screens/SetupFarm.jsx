import { useState } from 'react';
import { useLang } from '../i18n.js';
import { LangToggle } from '../App.jsx';
import { createFarm, cleanDeviceName } from '../devices.js';
import { saveSettings } from '../db.js';

/** Owner's first phone: the farm doc does not exist yet — name this phone and create it. */
export default function SetupFarm({ fb, user }) {
  const { t } = useLang();
  const [name, setName] = useState('');
  const [farmName, setFarmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    const n = cleanDeviceName(name);
    if (!n) return setErr(t('errInvalidName'));
    setBusy(true);
    try {
      await createFarm(fb, user.uid, n, farmName);
      // The dairy name shown in Settings and printed on bills lives in settings/main.
      const fn = farmName.trim().slice(0, 60);
      if (fn) saveSettings({ ...fb, farmId: user.uid }, { farmName: fn });
      fb.authMod.updateProfile(user, { displayName: n }).catch(() => {});
      // the farm listener switches to the main app once the server confirms
    } catch (e2) {
      console.error(e2);
      setErr(t('setupFailed') + (e2 && e2.code ? ` (${e2.code})` : ''));
      setBusy(false);
    }
  };

  return (
    <div className="center-screen" data-testid="setup-farm">
      <div className="top-right">
        <LangToggle />
      </div>
      <div className="logo">🥛</div>
      <form className="card login" onSubmit={submit}>
        <h2>{t('setupTitle')}</h2>
        <p className="small">{t('setupBody')}</p>
        <label>
          {t('deviceName')}
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={t('deviceNamePlaceholder')} required />
        </label>
        <label>
          {t('farmName')}
          <input value={farmName} maxLength={60} onChange={(e) => setFarmName(e.target.value)} />
        </label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary big" type="submit" disabled={busy}>
          {busy ? t('loading') : t('setupButton')}
        </button>
        <p className="muted small">{t('joinNeedsInternet')}</p>
        <p className="muted tiny">{user.email}</p>
      </form>
    </div>
  );
}
