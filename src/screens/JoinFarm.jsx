import { useState } from 'react';
import { useLang } from '../i18n.js';
import { LangToggle } from '../App.jsx';
import { joinFarm, normalizeCode, cleanDeviceName } from '../devices.js';

export const ERR_KEY = {
  invalidCode: 'errInvalidCode',
  invalidName: 'errInvalidName',
  notFound: 'errNotFound',
  used: 'errUsed',
  expired: 'errExpired',
  denied: 'errDenied',
  network: 'errNetwork',
  anonDisabled: 'errAnonDisabled',
};

/**
 * New phone: enter the 6-digit code + a name. Signs in anonymously (persistent per-install uid)
 * if needed, then adds itself to the farm while consuming the code.
 */
export default function JoinFarm({ fb, user, onJoined, onBack }) {
  const { t } = useLang();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!normalizeCode(code)) return setErr(t('errInvalidCode'));
    if (!cleanDeviceName(name)) return setErr(t('errInvalidName'));
    setBusy(true);
    try {
      let u = user || fb.auth.currentUser;
      if (!u) {
        try {
          u = (await fb.authMod.signInAnonymously(fb.auth)).user;
        } catch (e2) {
          console.error(e2);
          const c = (e2 && e2.code) || '';
          throw { reason: /operation-not-allowed|admin-restricted/.test(c) ? 'anonDisabled' : /network/.test(c) ? 'network' : 'denied' };
        }
      }
      const farmId = await joinFarm(fb, u.uid, code, name);
      fb.authMod.updateProfile(u, { displayName: cleanDeviceName(name) }).catch(() => {});
      onJoined(farmId, u);
    } catch (e3) {
      console.error(e3);
      setErr(t(ERR_KEY[e3 && e3.reason] || 'errDenied'));
      setBusy(false);
    }
  };

  return (
    <div className="center-screen" data-testid="join-farm">
      <div className="top-right">
        <LangToggle />
      </div>
      <div className="logo">📱</div>
      <form className="card login" onSubmit={submit}>
        <h2>{t('joinTitle')}</h2>
        <label>
          {t('pairingCode')}
          <input
            className="code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ''))}
            placeholder="123456"
            required
          />
        </label>
        <label>
          {t('deviceName')}
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={t('deviceNamePlaceholder')} required />
        </label>
        <p className="muted small">{t('deviceNameHint')}</p>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary big" type="submit" disabled={busy}>
          {busy ? t('loading') : t('joinButton')}
        </button>
        <p className="muted small">{t('joinNeedsInternet')}</p>
        {onBack && (
          <button type="button" className="btn ghost big" onClick={onBack} disabled={busy}>
            {t('back')}
          </button>
        )}
      </form>
    </div>
  );
}
