import { useLang } from '../i18n.js';
import { LangToggle } from '../App.jsx';

/** Lock screen after this phone was removed from the farm (local data already wiped). */
export default function Removed({ onRejoin }) {
  const { t } = useLang();
  return (
    <div className="center-screen" data-testid="removed">
      <div className="top-right">
        <LangToggle />
      </div>
      <div className="logo">🔒</div>
      <div className="card">
        <h2>{t('removedTitle')}</h2>
        <p>{t('removedBody')}</p>
        <button className="btn primary big" onClick={onRejoin}>
          {t('removedRejoin')}
        </button>
      </div>
    </div>
  );
}
