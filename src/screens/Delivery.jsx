// Delivery mode: walk through today's customers in route order, marking each
// delivered. Tapping "Delivered" instantly advances to the next customer.
// One card per customer for the whole day: paneer toggle, morning, evening, total.
// "As usual" fills the usual quantities; "Absent" records that the customer didn't take milk.
// The back button re-opens an earlier customer for corrections.
import { useEffect, useMemo, useRef, useState } from 'react';
import PaneerGrams from '../components/PaneerGrams.jsx';
import { useLang } from '../i18n.js';
import { saveEntries, deleteEntry } from '../db.js';
import { playSound } from '../feedback.js';
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

/** Whole-day card: done when every round the customer usually takes has milk, or it is a
    total-only entry. A morning entered in the Register keeps the customer on the list for evening. */
export function dayComplete(en, c) {
  if (!en || en.skip) return false;
  if (en.half) return false; // only the morning saved so far: comes back for the evening
  const m = Number(en.milkMorningL) || 0;
  const e = Number(en.milkEveningL) || 0;
  if (m <= 0 && e <= 0) return (Number(en.milkL) || 0) > 0;
  // Both rounds recorded (an evening of 0 L means "no evening milk today").
  return true;
}

/** Evening box on the card: what is saved, else empty (null = evening not delivered yet) for a
    customer who takes evening milk, 0 for one who doesn't. */
export function initEvening(en, c) {
  if (en && !en.skip && en.half !== 'morning' && (Number(en.milkMorningL) > 0 || Number(en.milkEveningL) > 0)) return Number(en.milkEveningL) || 0;
  return usualEvening(c) > 0 ? null : 0;
}

const usualFor = (c, session) =>
  session === 'morning' ? usualMorning(c) : session === 'evening' ? usualEvening(c) : usualMorning(c) + usualEvening(c);

/** Customers on today's round, in route order: active and not paused. Suppliers are included
    (their milk is recorded the same way; billing treats it as milk bought). For a morning/evening
    round only those who take milk in that round (or already got some). */
export function deliveryList(customers, saved, date, session) {
  return sortCustomers(
    customers.filter(
      (c) =>
        c.active !== false &&
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

function QtyEdit({ label, value, onChange, testId, placeholder }) {
  return (
    <label className="deli-qty" data-testid={testId}>
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
          value={value == null ? '' : value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === '' && placeholder ? null : Math.max(0, toMilli(e.target.value) / 1000))}
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
function DeliveryCard({ c, initM, initE, initT, initPaneer, morningSaved, onDelivered, onAbsent, onBack, canGoBack }) {
  const { t } = useLang();
  const [m, setM] = useState(initM);
  const [e, setE] = useState(initE);
  // Total box: > 0 means "total only" (morning and evening are 0). Editing morning or evening
  // clears it again and the day is morning + evening.
  const [tot, setTot] = useState(initT || 0);
  const [paneerOn, setPaneerOn] = useState(initPaneer > 0);
  const [paneer, setPaneer] = useState(initPaneer);
  const pp = paneerOn ? paneer : 0;
  const editM = (v) => {
    setM(v);
    setTot(0);
  };
  const editE = (v) => {
    setE(v);
    setTot(0);
  };
  const editT = (v) => {
    setTot(v);
    setM(0);
    setE(0);
  };
  const sum = Math.round((Number(m || 0) + Number(e || 0)) * 1000) / 1000;
  const total = tot > 0 ? tot : sum;
  const usual = usualMorning(c) + usualEvening(c);
  // Evening left empty (null) = only the morning is delivered now; the day stays incomplete and
  // the customer comes back for the evening. A Total, or morning + evening, completes the day.
  const deliverNow = () =>
    onDelivered(
      tot > 0
        ? { milkMorningL: 0, milkEveningL: 0, milkL: tot, paneerKg: pp, half: null }
        : { milkMorningL: m || 0, milkEveningL: e || 0, paneerKg: pp, half: e == null ? 'morning' : null },
      'delivered',
    );
  // "As usual" fills the round being delivered now: the morning on the first visit (evening still
  // to come), the evening when the morning is already saved.
  const asUsual = () =>
    onDelivered(
      morningSaved
        ? { milkMorningL: m || 0, milkEveningL: usualEvening(c), paneerKg: pp, half: null }
        : { milkMorningL: usualMorning(c), milkEveningL: e == null ? 0 : e, paneerKg: pp, half: e == null ? 'morning' : null },
      'usual',
    );

  return (
    <div className="card deli-card">
      <h2>
        {c.name}
        {c.isSupplier && <span className="tag supplier-tag"> 🏷️ {t('supplier')}</span>}
        {c.area && <span className="muted small"> · {c.area}</span>}
      </h2>
      <ToggleBar label={'🧀 ' + t('paneer')} on={paneerOn} onChange={setPaneerOn} testId="paneer-toggle" />
      {paneerOn && <PaneerGrams label={t('paneer') + ' (' + t('gram') + ')'} value={paneer} onChange={setPaneer} testId="paneer-qty" />}
      <QtyEdit label={t('session_morning')} value={m} onChange={editM} testId="qty-morning" />
      <QtyEdit
        label={t('session_evening')}
        value={e}
        onChange={editE}
        testId="qty-evening"
        placeholder={e == null ? t('asUsual') + ': ' + fmtQty(usualEvening(c)) : undefined}
      />
      <QtyEdit label={t('session_total')} value={tot} onChange={editT} testId="qty-total" />
      <p className="deli-total" data-testid="deli-total">
        {t('session_total')}: <b>{fmtQty(total)} {t('litre')}</b>
        <span className="muted small"> · {t('asUsual')}: {fmtQty(usual)} {t('litre')}</span>
      </p>
      <div className="form-actions">
        <button type="button" className="btn big" onClick={asUsual}>
          {t('asUsual')}
        </button>
        <button type="button" className="btn primary big" onClick={deliverNow}>
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
  // Paneer alone is not a milk delivery: a paneer-only "Delivered" is remembered via `skipped`.
  const isDelivered = (c) => !!doneNow[c.id] || dayComplete(saved[c.id], c) || !!(saved[c.id] && saved[c.id].skip);
  const remaining = list.filter((c) => !isDelivered(c) && !skipped[c.id]);
  const done = list.length - remaining.length;
  const current = review ? byId[review.id] : remaining[0];
  const canGoBack = review ? review.pos > 0 : history.length > 0;

  // Seed history from already-delivered customers (e.g. after an app restart) so Back works for them too.
  useEffect(() => {
    if (history.length === 0) {
      const seeded = list
        .filter((c) => dayComplete(saved[c.id], c) || !!(saved[c.id] && saved[c.id].skip) || (!!skipped[c.id] && (Number(saved[c.id] && saved[c.id].paneerKg) || 0) > 0))
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
    saveEntries(fb, date, { [c.id]: entry }, displayName, { [c.id]: saved[c.id] });
    const item = { id: c.id, m: entry.milkMorningL, e: entry.half === 'morning' ? null : entry.milkEveningL, p: entry.paneerKg || 0, total: entry.milkL };
    if (!deliveredFor(entry, session) && !((entry.paneerKg || 0) > 0)) {
      // Nothing delivered in this round (0 L): move on instead of showing the same customer forever.
      setSkipped((s) => ({ ...s, [c.id]: true }));
      if (review) setHistory((h) => h.filter((_, i) => i !== review.pos));
    } else {
      // paneer only (no milk): remember it on this phone so the card does not come back
      if (!deliveredFor(entry, session)) setSkipped((s) => ({ ...s, [c.id]: true }));
      if (review) setHistory((h) => h.map((x, i) => (i === review.pos ? item : x)));
      else {
        setDoneNow((d) => ({ ...d, [c.id]: true }));
        setHistory((h) => [...h, item]);
      }
    }
    setReview(null);
  };

  // Absent: didn't take milk today (the register's "didn't take" for the whole day).
  const markAbsent = (c) => {
    const prev = saved[c.id] || {};
    const entry = normaliseEntry(c, { milkMorningL: 0, milkEveningL: 0, paneerKg: 0, skip: true, note: prev.note || '' }, settings);
    saveEntries(fb, date, { [c.id]: entry }, displayName, { [c.id]: saved[c.id] });
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
      // keep a round that is already recorded (e.g. morning entered in the Register)
      const pm = Number(prev.milkMorningL) || 0;
      const pe = Number(prev.milkEveningL) || 0;
      const raw = { milkMorningL: pm > 0 ? pm : usualMorning(c), milkEveningL: pe > 0 ? pe : usualEvening(c) };
      rows[c.id] = normaliseEntry(c, { ...raw, paneerKg: prev.paneerKg || 0, skip: false, note: prev.note || '' }, settings);
      snap[c.id] = { prev: saved[c.id] || null, wrote: rows[c.id] };
      now[c.id] = true;
    });
    if (Object.keys(rows).length) {
      saveEntries(fb, date, rows, displayName, saved);
      setDoneNow((d) => ({ ...d, ...now }));
      setAllUsual(snap);
    }
  };

  // Switching "Everyone's usual" off puts back exactly what was there before it.
  const undoAllUsual = () => {
    const all = allUsual || {};
    const same = (a, b) =>
      !!a &&
      !!b &&
      !a.skip &&
      !b.skip &&
      Number(a.milkL || 0) === Number(b.milkL || 0) &&
      Number(a.milkMorningL || 0) === Number(b.milkMorningL || 0) &&
      Number(a.milkEveningL || 0) === Number(b.milkEveningL || 0) &&
      Number(a.paneerKg || 0) === Number(b.paneerKg || 0);
    // Only undo customers still exactly as the toggle wrote them: a correction made since then
    // (Back + edit, Absent, or on another phone) stays.
    const snap = {};
    Object.entries(all).forEach(([id, v]) => {
      const rec = v && typeof v === 'object' && 'wrote' in v ? v : { prev: v, wrote: null }; // 1.10.4 snapshots
      const now = saved[id];
      // (!now / same as prev: the listener has not caught up with the toggle's write yet)
      const untouched = !rec.wrote || same(now, rec.wrote) || (!now && !rec.prev) || same(now, rec.prev);
      if (untouched) snap[id] = rec.prev;
    });
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
            initM={review ? review.m || 0 : Number(saved[current.id]?.milkMorningL) || usualMorning(current)}
            initE={review ? review.e ?? null : initEvening(saved[current.id], current)}
            morningSaved={!review && !!saved[current.id] && saved[current.id].half === 'morning'}
            initT={review && !((review.m || 0) + (review.e || 0)) ? review.total || 0 : 0}
            initPaneer={review ? review.p || 0 : Number(saved[current.id]?.paneerKg) || 0}
            onDelivered={guarded((raw, kind) => {
              playSound(kind || 'delivered');
              deliver(current, raw);
            })}
            onAbsent={guarded(() => {
              playSound('absent');
              markAbsent(current);
            })}
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
