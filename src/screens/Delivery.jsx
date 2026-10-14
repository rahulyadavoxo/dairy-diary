// Delivery mode: walk through today's customers in route order, marking each
// delivered. Tapping "Delivered" instantly advances to the next customer.
// "As usual" fills the customer's usual quantity for the chosen round.
// Morning and evening are separate rounds: a customer who got morning milk is still due
// in the evening round. The back button re-opens an earlier customer for corrections.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../i18n.js';
import { saveEntries } from '../db.js';
import { normaliseEntry } from '../entry.js';
import { sortCustomers, isPaused } from './Register.jsx';
import { usualMorning, usualEvening } from './Customers.jsx';
import { todayISO, fmtQty } from '../format.js';
import { toMilli } from '../billing.js';
import { pushBackHandler } from '../backStack.js';

const step = (v, d) => Math.max(0, (Math.round(Number(v || 0) * 1000) + d) / 1000);

/** A second tap within this time after the card changed is ignored (double-tap guard). */
export const TAP_GUARD_MS = 600;

const SESSIONS = ['morning', 'evening', 'total'];
const DELI_SESSION_KEY = 'dd_deli_session';

/** Round to open with: the round picked earlier in this half of the day, else by the clock
    (morning before 1 pm, evening after). "Total" (one round a day) is remembered for good. */
export function deliverySession(now = new Date()) {
  const half = now.getHours() < 13 ? 'morning' : 'evening';
  try {
    const v = JSON.parse(localStorage.getItem(DELI_SESSION_KEY) || 'null');
    if (v && v.s === 'total') return 'total';
    if (v && SESSIONS.includes(v.s) && v.slot === `${todayISO()}-${half}`) return v.s;
  } catch {
    /* ignore */
  }
  return half;
}
function rememberSession(s) {
  const half = new Date().getHours() < 13 ? 'morning' : 'evening';
  try {
    localStorage.setItem(DELI_SESSION_KEY, JSON.stringify({ s, slot: `${todayISO()}-${half}` }));
  } catch {
    /* ignore */
  }
}

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

function DeliveryCard({ c, session, initM, initE, initPaneer, onDelivered, onSkip, onBack, canGoBack }) {
  const { t } = useLang();
  const [m, setM] = useState(initM);
  const [e, setE] = useState(initE);
  const [paneer, setPaneer] = useState(initPaneer);

  const qty = session === 'morning' ? m : session === 'evening' ? e : m + e;
  const setQty = (v) => {
    if (session === 'morning') setM(v);
    else if (session === 'evening') setE(v);
    else {
      // Total: keep it simple — all in morning, evening 0
      setM(v);
      setE(0);
    }
  };
  const asUsualQty = usualFor(c, session);

  const deliverNow = (mm, ee, pp) => onDelivered({ milkMorningL: mm, milkEveningL: ee, paneerKg: pp });

  return (
    <div className="card deli-card">
      <h2>
        {c.name}
        {c.area && <span className="muted small"> · {c.area}</span>}
      </h2>
      <div className="two">
        <QtyEdit label={t('session_' + session)} value={qty} onChange={setQty} />
        <QtyEdit label={t('paneer')} value={paneer} onChange={setPaneer} />
      </div>
      <p className="muted small">
        {t('asUsual')}: {fmtQty(asUsualQty)} {t('litre')}
      </p>
      <div className="form-actions">
        <button type="button" className="btn primary big" onClick={() => deliverNow(session === 'evening' ? 0 : m, session === 'morning' ? 0 : e, paneer)}>
          {t('delivered')}
        </button>
        <button
          type="button"
          className="btn big"
          onClick={() => {
            if (session === 'morning') deliverNow(usualMorning(c), 0, paneer);
            else if (session === 'evening') deliverNow(0, usualEvening(c), paneer);
            else deliverNow(usualMorning(c), usualEvening(c), paneer);
          }}
        >
          {t('asUsual')}
        </button>
      </div>
      <div className="form-actions">
        {canGoBack && (
          <button type="button" className="btn big" onClick={onBack}>
            ← {t('back')}
          </button>
        )}
        <button type="button" className="btn ghost" onClick={onSkip}>
          {t('skipDelivery')}
        </button>
      </div>
    </div>
  );
}

export default function Delivery(props) {
  const { t } = useLang();
  const [session, setSession] = useState(() => deliverySession());
  const pick = (s) => {
    rememberSession(s);
    setSession(s);
  };
  // Each round has its own list / history / skips: remount the round when the session changes.
  return <DeliveryRound key={session} {...props} session={session} setSession={pick} t={t} />;
}

function DeliveryRound({ fb, customers, days, settings, displayName, onBack, session, setSession, t }) {
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
        .filter((c) => deliveredFor(saved[c.id], session))
        .map((c) => {
          const en = saved[c.id] || {};
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

  const goBack = () => {
    const pos = review ? review.pos - 1 : history.length - 1;
    if (pos < 0 || !history[pos]) return;
    setReview({ ...history[pos], pos });
  };

  const deliverAllUsual = () => {
    const rows = {};
    const now = {};
    remaining.forEach((c) => {
      const prev = saved[c.id] || {};
      const raw =
        session === 'morning'
          ? { milkMorningL: usualMorning(c), milkEveningL: Number(prev.milkEveningL) || 0 }
          : session === 'evening'
            ? { milkMorningL: Number(prev.milkMorningL) || 0, milkEveningL: usualEvening(c) }
            : { milkMorningL: usualMorning(c), milkEveningL: usualEvening(c) };
      rows[c.id] = normaliseEntry(c, { ...raw, paneerKg: prev.paneerKg || 0, skip: false, note: prev.note || '' }, settings);
      now[c.id] = true;
    });
    if (Object.keys(rows).length) {
      saveEntries(fb, date, rows, displayName);
      setDoneNow((d) => ({ ...d, ...now }));
    }
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
        <div className="chips session-chips" role="tablist" aria-label={t('session')}>
          {SESSIONS.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={session === s}
              className={'btn chip' + (session === s ? ' on' : '')}
              onClick={() => s !== session && setSession(s)}
            >
              {t('session_' + s)}
            </button>
          ))}
        </div>
        {!settings.milkRatePaise && <p className="card warn small">{t('rateMissing')}</p>}
        {remaining.length > 0 && !review && (
          <button type="button" className="btn primary big" onClick={guarded(deliverAllUsual)}>
            {t('markAllUsual')}
          </button>
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
            session={session}
            initM={review ? (session === 'total' && !(review.m + review.e) ? review.total || 0 : review.m) : usualMorning(current)}
            initE={review ? review.e : usualEvening(current)}
            initPaneer={review ? review.p || 0 : 0}
            onDelivered={guarded((raw) => deliver(current, raw))}
            onSkip={guarded(() => {
              setReview(null);
              setSkipped((s) => ({ ...s, [current.id]: true }));
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
