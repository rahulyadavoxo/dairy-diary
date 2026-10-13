import { useState } from 'react';
import { useLang } from '../i18n.js';
import { LangToggle } from '../App.jsx';

export default function Login({ fb, onBack }) {
  const { t } = useLang();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await fb.authMod.signInWithEmailAndPassword(fb.auth, email.trim(), password);
    } catch (e2) {
      console.error(e2);
      setErr(t('loginFailed') + (e2 && e2.code ? ` (${e2.code})` : ''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen" data-testid="login">
      <div className="top-right">
        <LangToggle />
      </div>
      <div className="logo">🥛</div>
      <h1>{t('appName')}</h1>
      <form className="card login" onSubmit={submit}>
        <h2>{t('loginTitle')}</h2>
        <label>
          {t('email')}
          <input type="email" inputMode="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          {t('password')}
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {err && <p className="error">{err}</p>}
        <button className="btn primary big" type="submit" disabled={busy}>
          {busy ? t('loading') : t('login')}
        </button>
        <p className="muted small">{t('loginOfflineHint')}</p>
        {onBack && (
          <button type="button" className="btn ghost big" onClick={onBack} disabled={busy}>
            {t('back')}
          </button>
        )}
      </form>
    </div>
  );
}
