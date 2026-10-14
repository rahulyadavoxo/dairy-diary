import { useLang } from '../i18n.js';
import { openWhatsAppChat } from '../waShare.js';

/** Under "Share bill on WhatsApp": explains the first-chat limit and offers to open the chat. */
export default function WaDirectHelp({ phone }) {
  const { t } = useLang();
  return (
    <div className="wa-help" data-testid="wa-direct-help">
      <p className="muted small">{t('waDirectHint2')}</p>
      <button type="button" className="btn small ghost" onClick={() => openWhatsAppChat(phone).catch(() => {})}>
        💬 {t('waOpenChatBtn')} +{phone}
      </button>
    </div>
  );
}
