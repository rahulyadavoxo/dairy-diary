// Bill photos: render every customer's monthly bill as a PNG image,
// preview them, and share/download one by one or all together.
import { firstDeliveryMonth } from '../firstMonth.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../i18n.js';
import { computeMonth } from '../billing.js';
import { renderBillImage, billFileName, billFingerprint } from '../billImage.js';
import { validWaNumber, sendBillToWhatsApp, shareManyImages, isShareCancel } from '../waShare.js';
import { putCachedPhoto } from '../billCache.js';
import { addMonths, monthOf, todayISO } from '../format.js';
import MonthNav from '../components/MonthNav.jsx';

/** Month to open with: in the first 3 days of a month the bills to make are last month's
    (the bill sender uses last month too), so the current month is swapped for the previous one. */
export function defaultPhotoMonth(month, today = todayISO()) {
  const cur = monthOf(today);
  return month === cur && Number(today.slice(8, 10)) <= 3 ? addMonths(cur, -1) : month;
}

export default function BillPhotos({ customers, days, payments, settings, month: initialMonth, histOk = true, onClose }) {
  const { t } = useLang();
  const [month, setMonthState] = useState(initialMonth);
  const res = useMemo(
    () => computeMonth({ customers, days, payments, settings, month }),
    [customers, days, payments, settings, month],
  );
  const targets = useMemo(
    // Same rule as Hisaab / Send bills (money #3): inactive customers who still owe, and customers
    // with only an old balance, get a photo too.
    () => res.rows.filter((r) => !r.customer.isSupplier && (r.hasActivity || r.balancePaise !== 0)),
    [res],
  );
  const [photos, setPhotos] = useState([]); // [{id,name,url,blob}]
  const [working, setWorking] = useState(false);
  const [doneMsg, setDoneMsg] = useState('');
  const [shareErr, setShareErr] = useState('');

  const urls = useRef([]);
  const setMonth = (m) => {
    if (working) return;
    setPhotos([]);
    setDoneMsg('');
    setMonthState(m);
  };
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

  const showErr = (e) => {
    if (isShareCancel(e)) return;
    console.error('[bill-photos] share', e);
    setShareErr(e && e.code === 'NOT_INSTALLED' ? t('waNotInstalled') : t('shareFailed'));
  };

  const shareOne = async (p) => {
    setShareErr('');
    try {
      const c = customers.find((x) => x.id === p.id);
      await sendBillToWhatsApp({
        blob: p.blob,
        fileName: billFileName(p.name, month, p.id),
        phone: validWaNumber(c && c.phone),
      });
    } catch (e) {
      showErr(e);
    }
  };

  const downloadAll = async () => {
    setShareErr('');
    try {
      await shareManyImages(photos.map((p) => ({ blob: p.blob, fileName: billFileName(p.name, month, p.id) })));
    } catch (e) {
      // cancelled share sheet -> quiet; anything else -> visible error (it used to fail silently)
      showErr(e);
    }
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="btn small ghost" onClick={onClose}>
          ← {t('back')}
        </button>
        <h1>{t('billPhotos')}</h1>
        <MonthNav month={month} setMonth={setMonth} minMonth={firstDeliveryMonth(days)} />
        <p className="muted small">{t('billPhotosHint')}</p>
      </header>
      {/* money #7 / NEW-5: the photos' previous due may be incomplete until old history loads */}
      {!histOk && <p className="card warn small" data-testid="old-history-loading">{t('oldHistoryLoading')}</p>}
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
          {shareErr && <p className="err small" data-testid="photo-share-err">{shareErr}</p>}
          <ul className="rows photo-grid">
            {photos.map((p) => (
              <li key={p.id} className="card photo-card">
                <img src={p.url} alt={p.name} />
                <b>{p.name}</b>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => shareOne(p)}
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
