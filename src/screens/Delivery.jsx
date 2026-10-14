// Delivery mode: walk through today's customers in route order, marking each
// delivered. Tapping "Delivered" instantly advances to the next customer.
// One card per customer for the whole day: paneer toggle, morning, evening, total.
// "As usual" fills the usual quantities; "Absent" records that the customer didn't take milk.
// The back button re-opens an earlier customer for corrections.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../i18n.js';
import { saveEntries, deleteEntry } from '../db.js';
import { normaliseEntry } from '../entry.js';
import { sortCustomers, isPaused } from './Register.jsx';
import { usualMorning, usualEvening } from './Customers.jsx';
import { todayISO, fmtQty } from '../format.js';
import { toMilli } from '../billing.js';
import { pushBackHandler } from '../backStack.js';

const step = (v, d) => Math.max(0, (Math.round(Number(v || 0) * 1000) + d) / 1000);

/** A second tap within this time after the card changed is ignored (double-tap guard). */
export const TAP_GUARD_MS = 600;

/** Is this saved entry already delivered for the given round? A total-only entry (no
    morning/evening split) covers the whole day. */
export function deliveredFor(en, session) {
  if (!en || en.skip) return false;
  const total = Number(en.milkL) || 0;
  const m = Number(en.milkMorningL) || 0;
  const e = Number(en.milkEveningL) || 0;
  if (session === 'morning') return m > 0 || (total > 0 && m <= 0 && e <= 0);
  if (session === 'evening') return e > 0 || (total > 0 && m <= 0 && e <= 0);
  return total > 0;
}

const usualFor = (c, session) =>
  session === 'morning' ? usualMorning(c) : session === 'evening' ? usualEvening(c) : usualMorning(c) + usualEvening(c);

/** Customers on today's round: active, not paused, not suppliers (milk is bought from them),
    and for a morning/evening round only those who take milk in that round (or already got some). */
export function deliveryList(customers, saved, date, session) {
  return sortCustomers(
    customers.filter(
      (c) =>
        c.active !== false &&
        !c.isSupplier &&
        !isPaused(c, date) &&
        (session === 'total' || usualFor(c, session) > 0 || deliveredFor(saved[c.id], session)),
    ),
  );
}

// "Skip" is remembered on this phone for today's round only (it does not write an entry:
// a skip:true entry would zero the other round's milk in the bill).
const skipKey = (date, session) => `dd_deli_skip_${date}_${session}`;
function loadSkips(date, session) {
  try {
    return JSON.parse(localStorage.getItem(skipKey(date, session)) || '{}') || {};
  } catch {
    return {};
  }
}
function saveSkips(date, session, map) {
  try {
    // keep only today's keys
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('dd_deli_skip_') && !k.startsWith(`dd_deli_skip_${date}_`)) localStorage.removeItem(k);
    }
    localStorage.setItem(skipKey(date, session), JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function QtyEdit({ label, value, onChange }) {
  return (
    <label className="deli-qty">
      {label}
      <div className="stepper">
        <button type="button" className="btn step" onClick={() => onChange(step(value, -250))}>
          −
        </button>
        <input
          className="qty"
          type="number"
          inputMode="decimal"
          step="0.25"
          min="0"
          value={value}
          onChange={(e) => onChange(Math.max(0, toMilli(e.target.value) / 1000))}
        />
        <button type="button" className="btn step" onClick={() => onChange(step(value, 250))}>
          +
        </button>
      </div>
    </label>
  );
}

/** A big on/off bar (used for Paneer and "Everyone's usual"). */
export function ToggleBar({ label, on, onChange, testId }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-testid={testId}
      className={'toggle-bar' + (on ? ' on' : '')}
      onClick={() => onChange(!on)}
    >
      <span>{label}</span>
      <span className="switch" aria-hidden="true">
        <span className="knob" />
      </span>
    </button>
  );
}

// One card per customer for the whole day: Paneer (toggle, rarely sold) on top, then morning,
// evening and the day's total. "As usual" (left) / "Delivered" (right); "Absent" = didn't take today.
function DeliveryCard({ c, initM, initE, initPaneer, onDelivered, onAbsent, onBack, canGoBack }) {
  const { t } = useLang();
  const [m, setM] = useState(initM);
  const [e, setE] = useState(initE);
  const [paneerOn, setPaneerOn] = useState(initPaneer > 0);
  const [paneer, setPaneer] = useState(initPaneer);
  const pp = paneerOn ? paneer : 0;
  const total = Math.round((Number(m || 0) + Number(e || 0)) * 1000) / 1000;
  const usual = usualMorning(c) + usualEvening(c);

  return (
    <div className="card deli-card">
      <h2>
        {c.name}
        {c.area && <span className="muted small"> · {c.area}</span>}
      </h2>
      <ToggleBar label={'🧀 ' + t('paneer')} on={paneerOn} onChange={setPaneerOn} testId="paneer-toggle" />
      {paneerOn && <QtyEdit label={t('paneer') + ' (kg)'} value={paneer} onChange={setPaneer} />}
      <QtyEdit label={t('session_morning')} value={m} onChange={setM} />
      <QtyEdit label={t('session_evening')} value={e} onChange={setE} />
      <p className="deli-total" data-testid="deli-total">
        {t('session_total')}: <b>{fmtQty(total)} {t('litre')}</b>
        <span className="muted small"> · {t('asUsual')}: {fmtQty(usual)} {t('litre')}</span>
      </p>
      <div className="form-actions">
        <button type="button" className="btn big" onClick={() => onDelivered({ milkMorningL: usualMorning(c), milkEveningL: usualEvening(c), paneerKg: pp })}>
          {t('asUsual')}
        </button>
        <button type="button" className="btn primary big" onClick={() => onDelivered({ milkMorningL: m, milkEveningL: e, paneerKg: pp })}>
          {t('delivered')}
        </button>
      </div>
      <div className="form-actions">
        {canGoBack && (
          <button type="button" className="btn big" onClick={onBack}>
            ← {t('back')}
          </button>
        )}
        <button type="button" className="btn absent big" onClick={onAbsent}>
          {t('absent')}
        </button>
      </div>
    </div>
  );
}

// "Everyone's usual" can be switched off again: what it wrote is undone from this snapshot
// ({customerId: previous entry | null}), kept on this phone for today.
const allUsualKey = (date) => `dd_deli_allusual_${date}`;
function loadAllUsual(date) {
  try {
    return JSON.parse(localStorage.getItem(allUsualKey(date)) || 'null');
  } catch {
    return null;
  }
}
function saveAllUsual(date, snap) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('dd_deli_allusual_') && k !== allUsualKey(date)) localStorage.removeItem(k);
    }
    if (snap) localStorage.setItem(allUsualKey(date), JSON.stringify(snap));
    else localStorage.removeItem(allUsualKey(date));
  } catch {
    /* ignore */
  }
}

export default function Delivery(props) {
  const { t } = useLang();
  // One round for the whole day (morning + evening on the same card), per Rahul 2026-10-14.
  return <DeliveryRound {...props} session="total" t={t} />;
}

function DeliveryRound({ fb, customers, days, settings, displayName, onBack, session, t }) {
  const date = todayISO();
  const day = days[date] || null;
  const saved = (day && day.entries) || {};
  const list = useMemo(() => deliveryList(customers, saved, date, session), [customers, saved, date, session]);
  const byId = useMemo(() => Object.fromEntries(list.map((c) => [c.id, c])), [list]);
  const [skipped, setSkippedState] = useState(() => loadSkips(date, session));
  const setSkipped = (fn) =>
    setSkippedState((s) => {
      const n = fn(s);
      saveSkips(date, session, n);
      return n;
    });
  const [doneNow, setDoneNow] = useState({}); // delivered on this screen (before the listener catches up)
  const [history, setHistory] = useState([]); // [{id, m, e, p}] delivered, in order
  const [review, setReview] = useState(null); // {id, m, e, p, pos} | null — re-editing history[pos]
  const lastTap = useRef(0);

  /** Run an action unless the previous one was less than TAP_GUARD_MS ago (the next card
      appears under the finger, so a double tap used to mark the next customer too). */
  const guarded = (fn) => (...args) => {
    const now = Date.now();
    if (now - lastTap.current < TAP_GUARD_MS) return;
    lastTap.current = now;
    fn(...args);
  };

  // Hardware back button exits review mode first (before leaving delivery)
  useEffect(() => {
    if (!review) return;
    return pushBackHandler(() => setReview(null));
  }, [review]);

  // Done for this round: delivered now or earlier, or marked "didn't take" for the whole day in the register.
  const isDelivered = (c) => !!doneNow[c.id] || deliveredFor(saved[c.id], session) || !!(saved[c.id] && saved[c.id].skip);
  const remaining = list.filter((c) => !isDelivered(c) && !skipped[c.id]);
  const done = list.length - remaining.length;
  const current = review ? byId[review.id] : remaining[0];
  const canGoBack = review ? review.pos > 0 : history.length > 0;

  // Seed history from already-delivered customers (e.g. after an app restart) so Back works for them too.
  useEffect(() => {
    if (history.length === 0) {
      const seeded = list
        .filter((c) => deliveredFor(saved[c.id], session) || !!(saved[c.id] && saved[c.id].skip))
        .map((c) => {
          const en = saved[c.id] || {};
          if (en.skip) return { id: c.id, m: 0, e: 0, p: 0, total: 0, absent: true };
          return { id: c.id, m: en.milkMorningL || 0, e: en.milkEveningL || 0, p: en.paneerKg || 0, total: en.milkL || 0 };
        });
      if (seeded.length) setHistory(seeded);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const deliver = (c, raw) => {
    // Merge with what is already saved for today so delivering one session never wipes the
    // other session's milk (e.g. evening delivery must keep the morning quantity) or the note.
    const prev = saved[c.id] || {};
    const merged = { ...raw };
    if (session === 'morning' && prev.milkEveningL != null) merged.milkEveningL = Number(prev.milkEveningL) || 0;
    if (session === 'evening' && prev.milkMorningL != null) merged.milkMorningL = Number(prev.milkMorningL) || 0;
    // A total-only entry from earlier (no split): keep that milk in the other session's slot.
    const prevTotalOnly = (Number(prev.milkL) || 0) > 0 && !(Number(prev.milkMorningL) > 0) && !(Number(prev.milkEveningL) > 0);
    if (prevTotalOnly && !prev.skip) {
      if (session === 'morning') merged.milkEveningL = Number(prev.milkL);
      if (session === 'evening') merged.milkMorningL = Number(prev.milkL);
    }
    const entry = normaliseEntry(c, { ...merged, skip: false, note: prev.note || '' }, settings);
    saveEntries(fb, date, { [c.id]: entry }, displayName);
    const item = { id: c.id, m: entry.milkMorningL, e: entry.milkEveningL, p: entry.paneerKg || 0, total: entry.milkL };
    if (!deliveredFor(entry, session)) {
      // Nothing delivered in this round (0 L): move on instead of showing the same customer forever.
      setSkipped((s) => ({ ...s, [c.id]: true }));
      if (review) setHistory((h) => h.filter((_, i) => i !== review.pos));
    } else if (review) {
      setHistory((h) => h.map((x, i) => (i === review.pos ? item : x)));
    } else {
      setDoneNow((d) => ({ ...d, [c.id]: true }));
      setHistory((h) => [...h, item]);
    }
    setReview(null);
  };

  // Absent: didn't take milk today (the register's "didn't take" for the whole day).
  const markAbsent = (c) => {
    const prev = saved[c.id] || {};
    const entry = normaliseEntry(c, { milkMorningL: 0, milkEveningL: 0, paneerKg: 0, skip: true, note: prev.note || '' }, settings);
    saveEntries(fb, date, { [c.id]: entry }, displayName);
    const item = { id: c.id, m: 0, e: 0, p: 0, total: 0, absent: true };
    if (review) setHistory((h) => h.map((x, i) => (i === review.pos ? item : x)));
    else {
      setDoneNow((d) => ({ ...d, [c.id]: true }));
      setHistory((h) => [...h, item]);
    }
    setReview(null);
  };

  const goBack = () => {
    const pos = review ? review.pos - 1 : history.length - 1;
    if (pos < 0 || !history[pos]) return;
    setReview({ ...history[pos], pos });
  };

  const [allUsual, setAllUsualState] = useState(() => loadAllUsual(date));
  const setAllUsual = (snap) => {
    saveAllUsual(date, snap);
    setAllUsualState(snap);
  };

  const deliverAllUsual = () => {
    const rows = {};
    const now = {};
    const snap = {};
    remaining.forEach((c) => {
      const prev = saved[c.id] || {};
      snap[c.id] = saved[c.id] || null;
      const raw = { milkMorningL: usualMorning(c), milkEveningL: usualEvening(c) };
      rows[c.id] = normaliseEntry(c, { ...raw, paneerKg: prev.paneerKg || 0, skip: false, note: prev.note || '' }, settings);
      now[c.id] = true;
    });
    if (Object.keys(rows).length) {
      saveEntries(fb, date, rows, displayName);
      setDoneNow((d) => ({ ...d, ...now }));
      setAllUsual(snap);
    }
  };

  // Switching "Everyone's usual" off puts back exactly what was there before it.
  const undoAllUsual = () => {
    const snap = allUsual || {};
    const restore = {};
    Object.entries(snap).forEach(([id, prev]) => {
      if (prev) restore[id] = prev;
      else deleteEntry(fb, date, id, displayName);
    });
    if (Object.keys(restore).length) saveEntries(fb, date, restore, displayName);
    setDoneNow((d) => {
      const n = { ...d };
      Object.keys(snap).forEach((id) => delete n[id]);
      return n;
    });
    const ids = new Set(Object.keys(snap));
    setHistory((h) => h.filter((x) => !ids.has(x.id)));
    setAllUsual(null);
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="btn small ghost" onClick={onBack}>
          ← {t('back')}
        </button>
        <h1>
          🚚 {t('deliveryTitle')} <span className="muted small">({done}/{list.length})</span>
        </h1>
        {!settings.milkRatePaise && <p className="card warn small">{t('rateMissing')}</p>}
        {!review && (remaining.length > 0 || allUsual) && (
          <ToggleBar
            label={t('markAllUsual')}
            on={!!allUsual}
            onChange={guarded((v) => (v ? deliverAllUsual() : undoAllUsual()))}
            testId="all-usual-toggle"
          />
        )}
      </header>
      {list.length === 0 ? (
        <div className="center-screen">
          <p className="empty">{t('noCustomers')}</p>
          <button type="button" className="btn primary big" onClick={onBack}>
            ← {t('back')}
          </button>
        </div>
      ) : remaining.length === 0 && !review ? (
        <div className="center-screen">
          <h2>{t('deliveryDone')}</h2>
          {canGoBack && (
            <button type="button" className="btn big" onClick={guarded(goBack)}>
              ← {t('deliveryEditLast')}
            </button>
          )}
          <button type="button" className="btn primary big" onClick={onBack}>
            ← {t('back')}
          </button>
        </div>
      ) : (
        current && (
          <DeliveryCard
            key={current.id + (review ? '-review-' + review.pos : '')}
            c={current}
            initM={review ? (!(review.m + review.e) ? review.total || 0 : review.m) : usualMorning(current)}
            initE={review ? review.e : usualEvening(current)}
            initPaneer={review ? review.p || 0 : 0}
            onDelivered={guarded((raw) => deliver(current, raw))}
            onAbsent={guarded(() => markAbsent(current))}
            onBack={guarded(goBack)}
            canGoBack={canGoBack}
          />
        )
      )}
      {remaining.length > 0 && !review && (
        <p className="muted small">
          {remaining.length} {t('deliveryLeft')}
        </p>
      )}
    </div>
  );
}
