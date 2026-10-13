import { useLang } from '../i18n.js';
import { LangToggle } from '../App.jsx';

export default function NotConfigured() {
  const { t } = useLang();
  return (
    <div className="center-screen" data-testid="not-configured">
      <div className="top-right">
        <LangToggle />
      </div>
      <div className="logo">🥛</div>
      <h1>{t('appName')}</h1>
      <div className="card warn">
        <h2>{t('notConfiguredTitle')}</h2>
        <p>{t('notConfiguredBody')}</p>
        <p className="muted">{t('notConfiguredSteps')}</p>
      </div>
    </div>
  );
}
