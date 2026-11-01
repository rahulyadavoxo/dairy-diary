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
import { addMonths, addDays, monthOf, todayISO, monthName, rupees, dmy } from '../format.js';
import { dayFilled } from '../reminders.js';

const PROG_KEY = 'dd_wa_progress';
export const CHAIN_SECONDS = 3;

export function shouldPromptBills(settings) {
  return todayISO().slice(8, 10) === '01' && settings.billsSentForMonth !== monthOf(todayISO());
}

/** Who gets a WhatsApp bill (money #3, Nov 2026): anyone with a phone who has something this
 *  month OR still owes / has an advance - inactive ("band") customers included. */
export const isBillTarget = (r) =>
  !!r.customer.phone && !r.customer.isSupplier && (r.balancePaise !== 0 || r.hasActivity);

/** The sending order is frozen per bill month (by customer id), so a list that changes during
 *  sending (new customer, phone added, another phone's entries) never shifts the saved position.
 *  Ids that join later go to the END. `saved` = ids from localStorage for this month (or null). */
export function freezeOrder(prev, liveIds) {
  const base = prev || [];
  const extra = liveIds.filter((id) => !base.includes(id));
  return extra.length ? base.concat(extra) : base;
}

function readProgress(billMonth) {
  try {
    const p = JSON.parse(localStorage.getItem(PROG_KEY));
    if (p && p.month === billMonth) return p;
  } catch {
    /* ignore */
  }
  return null;
}

export default function BillSender({ fb, customers, days, payments, settings, month, histOk = true, onClose }) {
  const { t, lang } = useLang();
  // Nov 2026 (user): the WhatsApp button sends the month open in Hisaab (current month by
  // default, an older month after going back). The 1st-of-month banner passes last month.
  const billMonth = typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) ? month : addMonths(monthOf(todayISO()), -1);
  const isPastMonth = billMonth < monthOf(todayISO());
  const res = useMemo(
    () => computeMonth({ customers, days, payments, settings, month: billMonth }),
    [customers, days, payments, settings, billMonth],
  );
  const order = useRef(null); // frozen customer-id order for this bill month
  const targets = useMemo(() => {
    const liveIds = res.rows.filter(isBillTarget).map((r) => r.customerId);
    if (!order.current) {
      const p = readProgress(billMonth);
      if (p && Array.isArray(p.ids)) order.current = p.ids.filter((x) => typeof x === 'string');
      else if (liveIds.length) order.current = [];
    }
    if (!order.current) return [];
    order.current = freezeOrder(order.current, liveIds);
    const byId = new Map(res.rows.map((r) => [r.customerId, r]));
    // A frozen customer stays in place even if the row no longer qualifies (e.g. paid meanwhile);
    // only a deleted customer (no row) drops out.
    return order.current.map((id) => byId.get(id)).filter(Boolean);
  }, [res, billMonth]);
  const [idx, setIdx] = useState(() => {
    const p = readProgress(billMonth);
    if (p && Number.isInteger(p.idx)) {
      // After the last customer the saved idx === length: keep it there ("all sent"), never back
      // on the last customer (that invited a second send).
      const len = Array.isArray(p.ids) ? Math.max(p.ids.length, targets.length) : targets.length;
      return Math.max(0, Math.min(p.idx, len));
    }
    return 0;
  });
  // Last day of the bill month (e.g. 31 Oct) still empty -> every bill misses that day.
  const lastDay = addDays(`${addMonths(billMonth, 1)}-01`, -1);
  const lastEmpty =
    isPastMonth &&
    !dayFilled(days, null, lastDay) && (customers || []).some((c) => c.active !== false && !c.isSupplier);
  const [sendAnyway, setSendAnyway] = useState(false);
  const sendAnywayRef = useRef(false);
  const [askLastDay, setAskLastDay] = useState(null); // null, or the pickManually flag of the held press
  const [opened, setOpened] = useState(false);
  // Preview state + effect live ABOVE the early returns (Rules of Hooks): otherwise moving past
  // the last customer (idx === targets.length) renders fewer hooks and React crashes.
  const [imgUrl, setImgUrl] = useState(null);
  const [imgBlob, setImgBlob] = useState(null);
  // Which customer the ready photo belongs to - never share customer A's photo to customer B.
  const [blobFor, setBlobFor] = useState(null);
  const [imgErr, setImgErr] = useState('');
  const [shareErr, setShareErr] = useState('');
  const [noNumber, setNoNumber] = useState(false);
  const curRow = idx < targets.length ? targets[idx] : null;
  // Photo is remade whenever this customer's numbers change (payment from another phone, late data).
  const curFp = curRow ? billFingerprint(curRow, settings) : '';
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
    setBlobFor(null);
    setImgErr('');
    (async () => {
      try {
        const fp = curFp;
        let blob = await getCachedPhoto(curRow.customerId, billMonth, fp);
        if (!blob) {
          blob = await renderBillImage(curRow, billMonth, settings);
          putCachedPhoto(curRow.customerId, billMonth, blob, fp);
        }
        if (!live) return;
        url = URL.createObjectURL(blob);
        setImgBlob(blob);
        setBlobFor(curRow.customerId);
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
  }, [idx, curRow && curRow.customerId, curFp]);

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
    if (!autoOpen || !curRow || !imgBlob || blobFor !== curRow.customerId) return;
    setAutoOpen(false);
    if (validWaNumber(curRow.customer.phone) && shareRef.current) shareRef.current(false);
    else setChain(false);
  }, [autoOpen, curRow, imgBlob, blobFor]);

  useEffect(() => {
    try {
      localStorage.setItem(PROG_KEY, JSON.stringify({ month: billMonth, idx, ids: order.current || [] }));
    } catch {
      /* ignore */
    }
  }, [idx, billMonth, targets]);

  const finish = () => {
    if (billMonth === addMonths(monthOf(todayISO()), -1)) saveSettings(fb, { billsSentForMonth: monthOf(todayISO()) });
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
    if (!imgBlob || blobFor !== row.customerId) return;
    if (lastEmpty && !sendAnywayRef.current) {
      // Warn first (user can still send); the chain stops here until they decide.
      setAskLastDay(pickManually);
      setChain(false);
      return;
    }
    const n = validWaNumber(row.customer.phone);
    if (!n && !pickManually) { setNoNumber(true); setShareErr(''); return; }
    setNoNumber(false);
    setShareErr('');
    try {
      await sendBillToWhatsApp({
        blob: imgBlob,
        fileName: billFileName(row.customer.name, billMonth, row.customerId),
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

  // WhatsApp never tells us whether Send was pressed: the user says "not sent" -> same customer again,
  // nothing is counted as sent.
  const notSent = () => {
    setCountdown(null);
    if (shareRef.current) shareRef.current(false);
  };

  const prevCustomer = () => {
    stopChain();
    setOpened(false);
    setNoNumber(false);
    setShareErr('');
    setIdx((i) => Math.max(0, i - 1));
  };

  const nextCustomer = () => {
    setCountdown(null); // the countdown must not move a second time (it skipped a customer)
    setAutoOpen(false);
    away.current = false;
    setOpened(false);
    setNoNumber(false);
    setShareErr('');
    setIdx((i) => i + 1);
  };

  return (
    <div className="screen">
      <header className="screen-head">
        {/* User (16 Oct): no left Back here; top-right button steps the count back one customer. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
          <h1 style={{ margin: 0 }}>
            {t('waBillsTitle')} <span className="muted small">({idx + 1}/{targets.length})</span>
          </h1>
          <button
            type="button"
            className="btn small ghost"
            onClick={prevCustomer}
            disabled={idx === 0}
            data-testid="wa-prev"
            style={{ flexShrink: 0 }}
          >
            ← {t('waPrev')}
          </button>
        </div>
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
        {!histOk && <p className="card warn small" data-testid="old-history-loading">{t('oldHistoryLoading')}</p>}
        {lastEmpty && (
          <div className="card warn" data-testid="wa-lastday-empty">
            <p className="error">⚠️ {t('waLastDayEmpty').replace('{d}', dmy(lastDay, lang))}</p>
            {askLastDay !== null && !sendAnyway && (
              <>
                <button
                  type="button"
                  className="btn primary"
                  data-testid="wa-send-anyway"
                  onClick={() => {
                    const pick = askLastDay;
                    sendAnywayRef.current = true;
                    setSendAnyway(true);
                    setAskLastDay(null);
                    if (shareRef.current) shareRef.current(pick);
                  }}
                >
                  {t('waSendAnyway')}
                </button>
                <button type="button" className="btn" onClick={onClose} style={{ marginTop: '0.5rem' }}>
                  {t('waFillFirst')}
                </button>
              </>
            )}
          </div>
        )}
        {countdown !== null && (
          <div className="card warn" data-testid="chain-countdown">
            <p><b>{t('waChainNext').replace('{s}', countdown)}</b></p>
            <button type="button" className="btn big primary" onClick={notSent}>
              ↩ {t('waChainNotSent')}
            </button>
            <button type="button" className="btn big" onClick={stopChain} style={{ marginTop: '0.5rem' }}>
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
        ) : countdown === null ? (
          <button type="button" className="btn primary big" onClick={nextCustomer}>
            ✓ {t('waNext')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
