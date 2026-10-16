// Guided WhatsApp bill sending (free flow).
// On the 1st of a month, bills for the previous month are ready. This screen
// walks through every customer that has a phone number: it opens their WhatsApp
// chat with the bill text prefilled, the user presses Send, then moves to the
// next customer. Progress survives app restarts (localStorage).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../i18n.js';
import { computeMonth } from '../billing.js';
import { renderBillImage, billFileName, billFingerprint } from '../billImage.js';
import { validWaNumber, sendBillToWhatsApp, isShareCancel } from '../waShare.js';
import WaDirectHelp from '../components/WaDirectHelp.jsx';
import { getCachedPhoto, putCachedPhoto } from '../billCache.js';
import { saveSettings } from '../db.js';
import { addMonths, monthOf, todayISO, monthName, rupees } from '../format.js';

const PROG_KEY = 'dd_wa_progress';
export const CHAIN_SECONDS = 3;

export function shouldPromptBills(settings) {
  return todayISO().slice(8, 10) === '01' && settings.billsSentForMonth !== monthOf(todayISO());
}

export default function BillSender({ fb, customers, days, payments, settings, onClose }) {
  const { t, lang } = useLang();
  const billMonth = addMonths(monthOf(todayISO()), -1);
  const res = useMemo(
    () => computeMonth({ customers, days, payments, settings, month: billMonth }),
    [customers, days, payments, settings, billMonth],
  );
  const targets = useMemo(
    () =>
      res.rows.filter(
        (r) => r.customer.phone && r.customer.active !== false && !r.customer.isSupplier && (r.balancePaise !== 0 || r.hasActivity),
      ),
    [res],
  );
  const [idx, setIdx] = useState(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PROG_KEY));
      if (p && p.month === billMonth && Number.isInteger(p.idx)) return Math.min(p.idx, Math.max(0, targets.length - 1));
    } catch {
      /* ignore */
    }
    return 0;
  });
  const [opened, setOpened] = useState(false);
  // Preview state + effect live ABOVE the early returns (Rules of Hooks): otherwise moving past
  // the last customer (idx === targets.length) renders fewer hooks and React crashes.
  const [imgUrl, setImgUrl] = useState(null);
  const [imgBlob, setImgBlob] = useState(null);
  const [imgErr, setImgErr] = useState('');
  const [shareErr, setShareErr] = useState('');
  const [noNumber, setNoNumber] = useState(false);
  const curRow = idx < targets.length ? targets[idx] : null;
  // One-by-one chain (user, 16 Oct 2026): after a bill opens in WhatsApp and the user comes back,
  // the next customer's chat opens by itself after a 3 s countdown ("Ruko" stops it).
  // The user always presses Send in WhatsApp themselves - nothing is sent automatically.
  const [chain, setChain] = useState(false);
  const [countdown, setCountdown] = useState(null); // seconds left, or null
  const [autoOpen, setAutoOpen] = useState(false);
  const away = useRef(false); // a bill was just handed to WhatsApp
  const chainRef = useRef(false);
  chainRef.current = chain;
  const shareRef = useRef(null);

  // Render the bill image (with calendar) for preview — prefer cached photo
  useEffect(() => {
    if (!curRow) return undefined;
    let live = true;
    let url = null;
    setImgUrl(null);
    setImgBlob(null);
    setImgErr('');
    (async () => {
      try {
        const fp = billFingerprint(curRow, settings);
        let blob = await getCachedPhoto(curRow.customerId, billMonth, fp);
        if (!blob) {
          blob = await renderBillImage(curRow, billMonth, settings);
          putCachedPhoto(curRow.customerId, billMonth, blob, fp);
        }
        if (!live) return;
        url = URL.createObjectURL(blob);
        setImgBlob(blob);
        setImgUrl(url);
      } catch (e) {
        if (!live) return;
        console.error('[bill-render]', e);
        setImgErr(t('shareFailed'));
      }
    })();
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url); // free the preview image memory
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, curRow && curRow.customerId]);

  // Back from WhatsApp -> start the countdown.
  useEffect(() => {
    const back = () => {
      if (!away.current) return;
      away.current = false;
      if (chainRef.current) setCountdown(CHAIN_SECONDS);
    };
    const onVis = () => document.visibilityState === 'visible' && back();
    document.addEventListener('visibilitychange', onVis);
    let sub = null;
    let dead = false;
    import('@capacitor/app')
      .then(({ App }) => App.addListener('resume', back))
      .then((h) => (dead ? h && h.remove() : (sub = h)))
      .catch(() => {});
    return () => {
      dead = true;
      document.removeEventListener('visibilitychange', onVis);
      if (sub) sub.remove();
    };
  }, []);
  useEffect(() => {
    if (countdown === null) return undefined;
    if (countdown <= 0) {
      setCountdown(null);
      setOpened(false);
      setNoNumber(false);
      setShareErr('');
      setIdx((i) => i + 1);
      setAutoOpen(true);
      return undefined;
    }
    const id = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(id);
  }, [countdown]);
  // Next customer's photo is ready -> open their chat (or stop the chain when there's no number).
  useEffect(() => {
    if (!autoOpen || !curRow || !imgBlob) return;
    setAutoOpen(false);
    if (validWaNumber(curRow.customer.phone) && shareRef.current) shareRef.current(false);
    else setChain(false);
  }, [autoOpen, curRow, imgBlob]);

  useEffect(() => {
    try {
      localStorage.setItem(PROG_KEY, JSON.stringify({ month: billMonth, idx }));
    } catch {
      /* ignore */
    }
  }, [idx, billMonth]);

  const finish = () => {
    saveSettings(fb, { billsSentForMonth: monthOf(todayISO()) });
    try {
      localStorage.removeItem(PROG_KEY);
    } catch {
      /* ignore */
    }
    onClose();
  };

  if (targets.length === 0) {
    return (
      <div className="screen">
        <header className="screen-head">
          <button type="button" className="btn small ghost" onClick={onClose}>
            ← {t('back')}
          </button>
          <h1>{t('waBillsTitle')}</h1>
        </header>
        <p className="empty">{t('noActivity')}</p>
      </div>
    );
  }

  if (idx >= targets.length) {
    return (
      <div className="screen">
        <div className="center-screen">
          <h2>{t('waAllSent')}</h2>
          <button type="button" className="btn primary big" onClick={finish}>
            {t('waDone')}
          </button>
        </div>
      </div>
    );
  }

  const row = targets[idx];

  const sharePhoto = async (pickManually = false) => {
    if (!imgBlob) return;
    const n = validWaNumber(row.customer.phone);
    if (!n && !pickManually) { setNoNumber(true); setShareErr(''); return; }
    setNoNumber(false);
    setShareErr('');
    try {
      await sendBillToWhatsApp({
        blob: imgBlob,
        fileName: billFileName(row.customer.name, billMonth),
        phone: pickManually ? null : n,
      });
      setOpened(true);
      if (!pickManually) {
        away.current = true;
        setChain(true);
      }
    } catch (e) {
      if (isShareCancel(e)) return;
      console.error('[share-bill]', e);
      setShareErr(e && e.code === 'NOT_INSTALLED' ? t('waNotInstalled') : t('shareFailed'));
    }
  };

  shareRef.current = sharePhoto;
  const stopChain = () => {
    setCountdown(null);
    setChain(false);
    setAutoOpen(false);
    away.current = false;
  };

  const nextCustomer = () => {
    setOpened(false);
    setNoNumber(false);
    setShareErr('');
    setIdx((i) => i + 1);
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="btn small ghost" onClick={onClose}>
          ← {t('back')}
        </button>
        <h1>
          {t('waBillsTitle')} <span className="muted small">({idx + 1}/{targets.length})</span>
        </h1>
        <p className="muted small">
          {monthName(billMonth, lang)} · {t('sendBills')}
        </p>
      </header>
      <div className="card">
        <h2>
          {row.customer.name}
          <span className="muted small"> · {row.customer.phone}</span>
        </h2>
        <p>
          <b className={row.balancePaise > 0 ? 'due' : 'clear'}>{rupees(row.balancePaise)}</b>
        </p>
        {imgUrl ? (
          <img src={imgUrl} alt={row.customer.name} className="bill-preview-img" />
        ) : imgErr ? (
          <p className="err small">{imgErr}</p>
        ) : (
          <p className="muted small">{t('loading')}</p>
        )}
        {countdown !== null && (
          <div className="card warn" data-testid="chain-countdown">
            <p><b>{t('waChainNext').replace('{s}', countdown)}</b></p>
            <button type="button" className="btn big" onClick={stopChain}>
              ⏸ {t('waChainStop')}
            </button>
          </div>
        )}
        {!opened ? (
          <>
            <button
              type="button"
              className="btn whatsapp big"
              onClick={() => sharePhoto(false)}
              disabled={!imgBlob}
            >
              📤 {chain || idx > 0 ? t('waSharePhoto') : t('waChainStart')}
            </button>
            <p className="muted small" style={{ marginTop: '0.4rem' }}>{t('waChainHint')}</p>
            {shareErr && <p className="err small">{shareErr}</p>}
            {noNumber ? (
              <>
                <p className="err small" data-testid="wa-no-number">{t('waNoNumber')}</p>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => sharePhoto(true)}
                  disabled={!imgBlob}
                  style={{ marginTop: '0.5rem' }}
                >
                  {t('waPickManually')}
                </button>
              </>
            ) : validWaNumber(row.customer.phone) ? (
              <WaDirectHelp phone={validWaNumber(row.customer.phone)} />
            ) : (
              <p className="muted small" style={{ marginTop: '0.5rem' }}>{t('waNoNumber')}</p>
            )}
          </>
        ) : (
          <button type="button" className="btn primary big" onClick={nextCustomer}>
            ✓ {t('waNext')}
          </button>
        )}
      </div>
    </div>
  );
}
