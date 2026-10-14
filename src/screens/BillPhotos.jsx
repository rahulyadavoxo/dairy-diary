// Bill photos: render every customer's monthly bill as a PNG image,
// preview them, and share/download one by one or all together.
import { useMemo, useState } from 'react';
import { useLang } from '../i18n.js';
import { computeMonth } from '../billing.js';
import { renderBillImage, shareImage, billFileName } from '../billImage.js';
import { putCachedPhoto } from '../billCache.js';
import { monthName, rupees } from '../format.js';

export default function BillPhotos({ customers, days, payments, settings, month, onClose }) {
  const { t, lang } = useLang();
  const res = useMemo(
    () => computeMonth({ customers, days, payments, settings, month }),
    [customers, days, payments, settings, month],
  );
  const targets = useMemo(
    () => res.rows.filter((r) => r.customer.active !== false && r.hasActivity),
    [res],
  );
  const [photos, setPhotos] = useState([]); // [{id,name,url,blob}]
  const [working, setWorking] = useState(false);
  const [doneMsg, setDoneMsg] = useState('');

  const generate = async () => {
    setWorking(true);
    setDoneMsg('');
    const out = [];
    for (const r of targets) {
      // eslint-disable-next-line no-await-in-loop
      const blob = await renderBillImage(r, month, settings);
      // eslint-disable-next-line no-await-in-loop
      await putCachedPhoto(r.customerId, month, blob);
      out.push({ id: r.customerId, name: r.customer.name, url: URL.createObjectURL(blob), blob });
      setPhotos([...out]);
    }
    setWorking(false);
    setDoneMsg(t('photoDone'));
  };

  const downloadAll = async () => {
    for (const p of photos) {
      // eslint-disable-next-line no-await-in-loop
      await shareImage(p.blob, billFileName(p.name, month));
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 600));
    }
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="btn small ghost" onClick={onClose}>
          ← {t('back')}
        </button>
        <h1>
          {t('billPhotos')} <span className="muted small">{monthName(month, lang)}</span>
        </h1>
        <p className="muted small">{t('billPhotosHint')}</p>
      </header>
      {photos.length === 0 ? (
        <button type="button" className="btn primary big" disabled={working || targets.length === 0} onClick={generate}>
          {working ? t('loading') : `${t('makeBillPhotos')} (${targets.length})`}
        </button>
      ) : (
        <>
          <button type="button" className="btn primary big" onClick={downloadAll}>
            {t('downloadAll')} ({photos.length})
          </button>
          {doneMsg && <p className="ok small">{doneMsg}</p>}
          <ul className="rows photo-grid">
            {photos.map((p) => (
              <li key={p.id} className="card photo-card">
                <img src={p.url} alt={p.name} />
                <b>{p.name}</b>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => shareImage(p.blob, billFileName(p.name, month))}
                  >
                    {t('sharePhoto')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
