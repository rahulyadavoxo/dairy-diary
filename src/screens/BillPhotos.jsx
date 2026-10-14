// Bill photos: render every customer's monthly bill as a PNG image,
// preview them, and share/download one by one or all together.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../i18n.js';
import { computeMonth } from '../billing.js';
import { renderBillImage, shareImage, billFileName, billFingerprint } from '../billImage.js';
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

  const urls = useRef([]);
  // Revoke every preview URL when the screen closes (memory leak on low-RAM phones).
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const generate = async () => {
    setWorking(true);
    setDoneMsg('');
    const out = [];
    try {
      for (const r of targets) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const blob = await renderBillImage(r, month, settings);
          // eslint-disable-next-line no-await-in-loop
          await putCachedPhoto(r.customerId, month, blob, billFingerprint(r, settings));
          const url = URL.createObjectURL(blob);
          urls.current.push(url);
          out.push({ id: r.customerId, name: r.customer.name, url, blob });
          setPhotos([...out]);
        } catch (e) {
          // One failed render must not abort the whole batch.
          console.error('[bill-photos]', r.customer && r.customer.name, e);
        }
      }
      setDoneMsg(t('photoDone'));
    } finally {
      setWorking(false); // never leave the button stuck on "loading"
    }
  };

  const downloadAll = async () => {
    for (const p of photos) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await shareImage(p.blob, billFileName(p.name, month));
      } catch (e) {
        // user cancelled the share sheet (AbortError) — stop instead of an unhandled rejection
        console.error('[bill-photos] share', e);
        break;
      }
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
                    onClick={() => shareImage(p.blob, billFileName(p.name, month)).catch((e) => console.error('[bill-photos] share', e))}
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
