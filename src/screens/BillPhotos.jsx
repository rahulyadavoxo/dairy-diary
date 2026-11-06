// Bill photos: render every customer's monthly bill as a PNG image,
// preview them, and share/download one by one or all together.
import { firstDeliveryMonth } from '../firstMonth.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../i18n.js';
import { computeMonth, withLaterPayments } from '../billing.js';
import { renderBillImage, billFileName, billFingerprint } from '../billImage.js';
import { validWaNumber, sendBillToWhatsApp, shareManyImages, isShareCancel, chunkList, SHARE_CHUNK } from '../waShare.js';
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
    () => {
      const r0 = computeMonth({ customers, days, payments, settings, month });
      return { ...r0, rows: r0.rows.map((r) => withLaterPayments(r, payments, month, todayISO())) };
    },
    [customers, days, payments, settings, month],
  );
  const targets = useMemo(
    // Same rule as Hisaab / Send bills (money #3): inactive customers who still owe, and customers
    // with only an old balance, get a photo too.
    () => res.rows.filter((r) => !r.customer.isSupplier && (r.hasActivity || r.balancePaise !== 0)),
    [res],
  );
  const [photos, setPhotos] = useState([]); // [{id,name,url,blob,fp}]
  const [working, setWorking] = useState(false);
  const [doneMsg, setDoneMsg] = useState('');
  const [shareErr, setShareErr] = useState('');

  const urls = useRef([]);
  // fix-bills #10: each photo keeps the fingerprint of the numbers it shows. When the data changes
  // (payment / entry from another phone, late sync, old history loading) the photo is remade before
  // it is shown or shared - never an old amount.
  const latest = useRef({ res, settings, month });
  latest.current = { res, settings, month };
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const remaking = useRef(null);
  const makePhoto = async (r, m, st) => {
    const fp = billFingerprint(r, st);
    const blob = await renderBillImage(r, m, st);
    await putCachedPhoto(r.customerId, m, blob, fp);
    const url = URL.createObjectURL(blob);
    urls.current.push(url);
    return { id: r.customerId, name: r.customer.name, url, blob, fp, month: m };
  };
  /** The photo as it must be now (remade when stale), or null when the customer is gone. */
  const freshPhoto = async (p) => {
    const { res: rs, settings: st, month: m } = latest.current;
    const row = rs.rows.find((x) => x.customerId === p.id);
    if (!row || p.month !== m) return null;
    if (billFingerprint(row, st) === p.fp) return p;
    const np = await makePhoto(row, m, st);
    setPhotos((list) => list.map((x) => (x.id === p.id ? np : x)));
    return np;
  };
  const refreshStale = async () => {
    if (remaking.current) return remaking.current;
    const job = (async () => {
      await null; // let `remaking.current = job` happen first
      try {
        for (;;) {
          const { res: rs, settings: st, month: m } = latest.current;
          const stale = photosRef.current.find((p) => {
            const row = rs.rows.find((x) => x.customerId === p.id);
            return !row || p.month !== m || billFingerprint(row, st) !== p.fp;
          });
          if (!stale) break;
          // eslint-disable-next-line no-await-in-loop
          const np = await freshPhoto(stale);
          if (!np) {
            setPhotos((list) => list.filter((x) => x.id !== stale.id));
            photosRef.current = photosRef.current.filter((x) => x.id !== stale.id);
          } else {
            photosRef.current = photosRef.current.map((x) => (x.id === np.id ? np : x));
          }
        }
      } catch (e) {
        console.error('[bill-photos] remake', e);
      } finally {
        if (remaking.current === job) remaking.current = null;
      }
    })();
    remaking.current = job;
    return job;
  };
  const setMonth = (m) => {
    if (working) return;
    setPhotos([]);
    setDoneMsg('');
    setMonthState(m);
  };
  // Revoke every preview URL when the screen closes (memory leak on low-RAM phones).
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  // Data changed after the photos were made -> remake the photos whose numbers changed.
  useEffect(() => {
    if (working || photosRef.current.length === 0) return;
    refreshStale();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res, settings, working]);

  const generate = async () => {
    setWorking(true);
    setDoneMsg('');
    const out = [];
    try {
      for (const r of targets) {
        try {
          // eslint-disable-next-line no-await-in-loop
          out.push(await makePhoto(r, month, settings));
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

  const shareOne = async (p0) => {
    setShareErr('');
    try {
      const p = await freshPhoto(p0); // remade first if a payment / entry changed it
      if (!p) return;
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

  // Big farms (recheck NEW-7): at most SHARE_CHUNK photos per share sheet, one button per part.
  const parts = chunkList(photos, SHARE_CHUNK);
  const downloadAll = async (list = photos) => {
    setShareErr('');
    try {
      const fresh = [];
      for (const p of list) {
        // eslint-disable-next-line no-await-in-loop
        const np = await freshPhoto(p);
        if (np) fresh.push(np);
      }
      await shareManyImages(fresh.map((p) => ({ blob: p.blob, fileName: billFileName(p.name, month, p.id) })));
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
          {parts.length <= 1 ? (
            <button type="button" className="btn primary big" onClick={() => downloadAll(photos)}>
              {t('downloadAll')} ({photos.length})
            </button>
          ) : (
            parts.map((part, k) => {
              const from = k * SHARE_CHUNK + 1;
              return (
                <button
                  key={from}
                  type="button"
                  className="btn primary big"
                  data-testid="download-part"
                  onClick={() => downloadAll(part)}
                  style={{ marginBottom: '0.5rem' }}
                >
                  {t('downloadAll')} ({from}–{from + part.length - 1} / {photos.length})
                </button>
              );
            })
          )}
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
