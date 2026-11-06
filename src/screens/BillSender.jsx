// Guided WhatsApp bill sending (free flow).
// On the 1st of a month, bills for the previous month are ready. This screen
// walks through every customer that has a phone number: it opens their WhatsApp
// chat with the bill text prefilled, the user presses Send, then moves to the
// next customer. Progress survives app restarts (localStorage).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../i18n.js';
import { computeMonth, withLaterPayments, leftOf } from '../billing.js';
import { renderBillImage, billFileName, billFingerprint } from '../billImage.js';
import { validWaNumber, sendBillToWhatsApp, isShareCancel } from '../waShare.js';
import WaDirectHelp from '../components/WaDirectHelp.jsx';
import { getCachedPhoto, putCachedPhoto } from '../billCache.js';
import { saveSettings, markHandSent } from '../db.js';
import { addMonths, addDays, monthOf, todayISO, monthName, rupees, dmy } from '../format.js';
import { dayFilled } from '../reminders.js';

// Progress is kept PER bill month (recheck Nov 2026): one shared slot let opening another month wipe
// a half-done month, and a mid-month (partial) run was resumed as the final bill on the 1st.
const OLD_PROG_KEY = 'dd_wa_progress';
export const PROG_PREFIX = 'dd_wa_progress:';
export const progKey = (m) => PROG_PREFIX + m;
// Position "after customer X" (all sent so far). A customer that joins later is appended after X
// and still shows up; END alone is "after everyone" for an empty order.
const AFTER = 'after:';
const END = AFTER;
export const CHAIN_SECONDS = 3;

export function shouldPromptBills(settings, today = todayISO()) {
  if (today.slice(8, 10) !== '01' || settings.billsSentForMonth === monthOf(today)) return false;
  // fix-bills #2: auto-bill on (and connected) -> the server sends last month; the hand banner
  // would send the same bills twice. It comes back only when the server's run for last month
  // stopped with an error (bad token, everyone failed) and is not done.
  const ab = settings.autoBill || {};
  if (ab.enabled && ab.connected) {
    const lr = ab.lastRun || {};
    return lr.month === addMonths(monthOf(today), -1) && !!lr.error && !lr.done;
  }
  return true;
}

/** fix-bills #3: hand sends of a FINISHED month are recorded for the auto-bill server while
 *  auto-bill is on, so it skips those customers. */
export const recordsHandSend = (settings, isPastRun) =>
  !!isPastRun && !!(settings && settings.autoBill && settings.autoBill.enabled);

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

/** One-time move of the old single-slot progress. Only a month up to Oct 2026 is kept: before
 *  1.10.58 the sender could only send a finished (past) month, so that progress is a final run.
 *  A newer month in the old slot may be a mid-month run and is dropped (never resumed as final). */
function migrateOldProgress() {
  try {
    const raw = localStorage.getItem(OLD_PROG_KEY);
    if (raw === null) return;
    localStorage.removeItem(OLD_PROG_KEY);
    const old = JSON.parse(raw);
    if (old && typeof old.month === 'string' && old.month <= '2026-10' && old.month < monthOf(todayISO())
        && !localStorage.getItem(progKey(old.month))) {
      localStorage.setItem(progKey(old.month), JSON.stringify({ ...old, past: true }));
    }
  } catch {
    /* ignore */
  }
}

/** Saved progress of `billMonth`, only if it belongs to the same kind of run:
 *  - a run made while the month was still running (partial bill) never counts for the final
 *    (past-month) run, and
 *  - a partial run is resumed only on the same day (the bill is different tomorrow). */
export function readProgress(billMonth, isPast, today = todayISO()) {
  migrateOldProgress();
  try {
    const p = JSON.parse(localStorage.getItem(progKey(billMonth)));
    if (!p || p.month !== billMonth) return null;
    if (!!p.past !== !!isPast) return null;
    if (!isPast && p.day !== today) return null;
    return p;
  } catch {
    return null;
  }
}

function writeProgress(billMonth, p) {
  try {
    localStorage.setItem(progKey(billMonth), JSON.stringify(p));
    // drop progress of months older than 3 months (localStorage must not keep growing)
    const oldest = addMonths(monthOf(todayISO()), -3);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PROG_PREFIX) && k.slice(PROG_PREFIX.length) < oldest) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

function clearProgress(billMonth) {
  try {
    localStorage.removeItem(progKey(billMonth));
  } catch {
    /* ignore */
  }
}

export default function BillSender({ fb, customers, days, payments, settings, month, histOk = true, onClose }) {
  const { t, lang } = useLang();
  // Nov 2026 (user): the WhatsApp button sends the month open in Hisaab (current month by
  // default, an older month after going back). The 1st-of-month banner passes last month.
  const billMonth = typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) ? month : addMonths(monthOf(todayISO()), -1);
  const isPastMonth = billMonth < monthOf(todayISO());
  // Kind of run, fixed when the screen opens: a mid-month run that is still open after midnight on
  // the 1st stays a partial run (it must never be saved/finished as the final bill).
  const session = useRef(null);
  if (!session.current || session.current.month !== billMonth) {
    const sv = readProgress(billMonth, isPastMonth);
    // the run's start day stays fixed (rewriting it after midnight resumed a stale mid-month run)
    session.current = { month: billMonth, past: isPastMonth, saved: sv, day: (sv && sv.day) || todayISO() };
  }
  const sessionPast = session.current.past;
  const saved = session.current.saved;
  const res = useMemo(
    () => {
      // later payments count on the bill (a customer who already paid is not asked for it again)
      const r0 = computeMonth({ customers, days, payments, settings, month: billMonth });
      return { ...r0, rows: r0.rows.map((r) => withLaterPayments(r, payments, billMonth, todayISO())) };
    },
    [customers, days, payments, settings, billMonth],
  );
  const order = useRef(null); // frozen customer-id order for this bill month
  const targets = useMemo(() => {
    const liveIds = res.rows.filter(isBillTarget).map((r) => r.customerId);
    if (!order.current) {
      const p = saved;
      if (p && Array.isArray(p.ids)) order.current = p.ids.filter((x) => typeof x === 'string');
      else if (liveIds.length) order.current = [];
    }
    if (!order.current) return [];
    order.current = freezeOrder(order.current, liveIds);
    const byId = new Map(res.rows.map((r) => [r.customerId, r]));
    // A frozen customer stays in place even if the row no longer qualifies (e.g. paid meanwhile);
    // only a deleted customer (no row) drops out. Its id stays in the frozen order, so the
    // position (kept by customer id, below) never shifts onto the wrong customer.
    return order.current.map((id) => byId.get(id)).filter(Boolean);
  }, [res, billMonth, saved]);
  // The position is a customer ID, not a number (recheck NEW-4): when an EARLIER customer is
  // deleted during sending, the current one stays current and nobody is skipped.
  const [curId, setCurId] = useState(() => {
    const p = saved;
    if (!p) return null;
    if (typeof p.curId === 'string') return p.curId;
    if (Number.isInteger(p.idx)) {
      const ids = Array.isArray(p.ids) ? p.ids : (order.current || []);
      const len = Math.max(ids.length, targets.length);
      // After the last customer the saved idx === length: keep it there ("all sent"), never back
      // on the last customer (that invited a second send).
      if (p.idx >= len) return ids.length ? AFTER + ids[ids.length - 1] : END;
      if (p.idx <= 0) return null;
      return ids[p.idx] || (targets[p.idx] && targets[p.idx].customerId) || null;
    }
    return null;
  });
  /** Index in `targets` of a position id: a deleted id points at the next customer still there. */
  const idxOf = (id) => {
    if (id === null || id === undefined) return 0;
    const ord = order.current || [];
    const after = id.startsWith(AFTER);
    const key = after ? id.slice(AFTER.length) : id;
    if (after && !key) return targets.length;
    const at = ord.indexOf(key);
    if (at < 0) return after ? targets.length : 0;
    let n = 0;
    let live = false;
    for (const r of targets) {
      const k = ord.indexOf(r.customerId);
      if (k < at) n++;
      else if (k === at) live = true;
    }
    return after && live ? n + 1 : n;
  };
  const idx = Math.min(idxOf(curId), targets.length);
  const idxRef = useRef(idx);
  idxRef.current = idx;
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  /** Move to position i (0..length); i === length = "all sent". */
  const setIdx = (next) => {
    const tg = targetsRef.current;
    const i = Math.max(0, typeof next === 'function' ? next(idxRef.current) : next);
    const id = i >= tg.length ? (tg.length ? AFTER + tg[tg.length - 1].customerId : END) : tg[i].customerId;
    idxRef.current = Math.min(i, tg.length);
    setCurId(id);
  };
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

  // Saved per month, with the kind of run (past = final bill) and the day (partial runs resume
  // only the same day). Nothing is written while there is no list yet.
  useEffect(() => {
    if (!order.current) return;
    const id = idx >= targets.length
      ? (targets.length ? AFTER + targets[targets.length - 1].customerId : END)
      : targets[idx].customerId;
    writeProgress(billMonth, {
      month: billMonth,
      past: sessionPast,
      day: session.current.day,
      idx,
      curId: id,
      ids: order.current,
    });
  }, [idx, billMonth, targets, sessionPast]);

  const finish = () => {
    // Only a finished FINAL run (a past month, opened as past) marks the month's bills as sent.
    const thisMonth = monthOf(todayISO());
    if (sessionPast && billMonth < thisMonth && billMonth === addMonths(thisMonth, -1)) {
      saveSettings(fb, { billsSentForMonth: thisMonth });
    }
    clearProgress(billMonth);
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
          {/* Way back (recheck NEW-3): "Next" pressed by mistake on the last one, or WhatsApp didn't open. */}
          <button
            type="button"
            className="btn ghost"
            data-testid="wa-prev-end"
            onClick={() => {
              setCountdown(null);
              setChain(false);
              setAutoOpen(false);
              away.current = false;
              setOpened(false);
              setNoNumber(false);
              setShareErr('');
              setIdx(targets.length - 1);
            }}
            style={{ marginBottom: '0.75rem' }}
          >
            ← {t('waPrev')}
          </button>
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
      // Auto-bill on: tell the server this customer's bill went by hand (no second bill).
      if (recordsHandSend(settings, sessionPast && isPastMonth) && fb) markHandSent(fb, billMonth, row.customerId);
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
          <b className={leftOf(row) > 0 ? 'due' : 'clear'}>{rupees(leftOf(row))}</b>
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
