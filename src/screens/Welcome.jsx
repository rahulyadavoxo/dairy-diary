import { useLang } from '../i18n.js';
import { LangToggle } from '../App.jsx';

/** First launch on a phone with nobody signed in: owner sign-in or join with a code. */
export default function Welcome({ onOwner, onJoin }) {
  const { t } = useLang();
  return (
    <div className="center-screen" data-testid="welcome">
      <div className="top-right">
        <LangToggle />
      </div>
      <div className="logo">🥛</div>
      <h1>{t('appName')}</h1>
      <div className="card">
        <h2>{t('welcomeTitle')}</h2>
        <button className="btn primary big" onClick={onJoin}>
          {t('welcomeJoin')}
        </button>
        <p className="muted small">{t('welcomeJoinHint')}</p>
        <hr className="sep" />
        <button className="btn big" onClick={onOwner}>
          {t('welcomeOwner')}
        </button>
        <p className="muted small">{t('welcomeOwnerHint')}</p>
      </div>
    </div>
  );
}
