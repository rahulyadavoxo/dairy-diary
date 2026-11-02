import { useState } from 'react';
import { useLang } from '../i18n.js';
import { LangToggle } from '../App.jsx';

export const PRIVACY_URL = 'https://rahulyadavoxo.github.io/dairy-diary/privacy.html';
export const TERMS_URL = 'https://rahulyadavoxo.github.io/dairy-diary/terms.html';

/** Owner sign-in, or a new dairy owner creates an account (sign-up, Nov 2026). After sign-up the
 *  usual owner flow runs: no farm doc yet -> SetupFarm names the phone and the dairy. */
export default function Login({ fb, onBack }) {
  const { t } = useLang();
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const signup = mode === 'signup';

  const switchMode = (m) => {
    setMode(m);
    setErr('');
    setInfo('');
    setPassword2('');
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setInfo('');
    if (signup) {
      if (password.length < 6) return setErr(t('signupShortPass'));
      if (password !== password2) return setErr(t('signupPassMismatch'));
      if (!agree) return setErr(t('signupAgreeFirst'));
    }
    setBusy(true);
    try {
      if (signup) await fb.authMod.createUserWithEmailAndPassword(fb.auth, email.trim(), password);
      else await fb.authMod.signInWithEmailAndPassword(fb.auth, email.trim(), password);
    } catch (e2) {
      console.error(e2);
      const code = e2 && e2.code ? e2.code : '';
      let msg = signup ? t('signupFailed') : t('loginFailed');
      if (code === 'auth/email-already-in-use') msg = t('signupEmailUsed');
      else if (code === 'auth/invalid-email') msg = t('signupBadEmail');
      else if (code === 'auth/weak-password') msg = t('signupShortPass');
      setErr(msg + (code ? ` (${code})` : ''));
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    setErr('');
    setInfo('');
    const em = email.trim();
    if (!em) return setErr(t('forgotNeedEmail'));
    setBusy(true);
    try {
      await fb.authMod.sendPasswordResetEmail(fb.auth, em);
      setInfo(t('forgotSent'));
    } catch (e2) {
      console.error(e2);
      setErr(t('forgotFailed') + (e2 && e2.code ? ` (${e2.code})` : ''));
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
        <h2>{signup ? t('signupTitle') : t('loginTitle')}</h2>
        {signup && <p className="muted small">{t('signupHint')}</p>}
        <label>
          {t('email')}
          <input type="email" inputMode="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          {t('password')}
          <input
            type="password"
            autoComplete={signup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {signup && (
          <>
            <label>
              {t('signupPassAgain')}
              <input type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} required />
            </label>
            <div className="lbl small" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <input type="checkbox" id="dd-agree" data-testid="signup-agree" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>
                <span onClick={() => setAgree(!agree)}>{t('signupAgree')} </span>
                <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
                  {t('privacyPolicy')}
                </a>{' '}
                &amp;{' '}
                <a href={TERMS_URL} target="_blank" rel="noreferrer">
                  {t('termsOfUse')}
                </a>
              </span>
            </div>
          </>
        )}
        {err && <p className="error">{err}</p>}
        {info && <p className="ok small">{info}</p>}
        <button className="btn primary big" type="submit" disabled={busy} data-testid={signup ? 'signup-submit' : 'login-submit'}>
          {busy ? t('loading') : signup ? t('signupBtn') : t('login')}
        </button>
        {!signup && (
          <button type="button" className="btn ghost small" onClick={forgot} disabled={busy} data-testid="forgot-pass">
            {t('forgotPass')}
          </button>
        )}
        <p className="muted small">{t('loginOfflineHint')}</p>
        <button type="button" className="btn big" onClick={() => switchMode(signup ? 'login' : 'signup')} disabled={busy} data-testid="toggle-signup">
          {signup ? t('haveAccount') : t('newDairySignup')}
        </button>
        {onBack && (
          <button type="button" className="btn ghost big" onClick={onBack} disabled={busy}>
            {t('back')}
          </button>
        )}
      </form>
    </div>
  );
}
