// Delivery mode: walk through today's customers in route order, marking each
// delivered. Tapping "Delivered" instantly advances to the next customer.
// "As usual" fills the customer's usual morning/evening quantities.
// The back button re-opens the previously delivered customer for corrections.
import { useEffect, useMemo, useState } from 'react';
import { useLang } from '../i18n.js';
import { saveEntries } from '../db.js';
import { normaliseEntry } from '../entry.js';
import { sortCustomers, isPaused } from './Register.jsx';
import { usualMorning, usualEvening } from './Customers.jsx';
import { todayISO, fmtQty } from '../format.js';
import { toMilli } from '../billing.js';
import { pushBackHandler } from '../backStack.js';

const step = (v, d) => Math.max(0, (Math.round(Number(v || 0) * 1000) + d) / 1000);

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

function DeliveryCard({ c, initM, initE, initPaneer, onDelivered, onSkip, onBack, canGoBack }) {
  const { t } = useLang();
  const [session, setSession] = useState('total');
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
  const asUsualQty = session === 'morning' ? usualMorning(c) : session === 'evening' ? usualEvening(c) : usualMorning(c) + usualEvening(c);

  const deliverNow = (mm, ee, pp) => onDelivered({ milkMorningL: mm, milkEveningL: ee, paneerKg: pp });

  return (
    <div className="card deli-card">
      <h2>
        {c.name}
        {c.area && <span className="muted small"> · {c.area}</span>}
      </h2>
      <div className="chips session-chips" role="tablist">
        {['morning', 'evening', 'total'].map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={session === s}
            className={'btn chip' + (session === s ? ' on' : '')}
            onClick={() => setSession(s)}
          >
            {t('session_' + s)}
          </button>
        ))}
      </div>
      <div className="two">
        <QtyEdit label={session === 'total' ? t('session_total') : t('session_' + session)} value={qty} onChange={setQty} />
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

export default function Delivery({ fb, customers, days, settings, displayName, onBack }) {
  const { t } = useLang();
  const date = todayISO();
  const day = days[date] || null;
  const saved = (day && day.entries) || {};
  const list = useMemo(
    () => sortCustomers(customers.filter((c) => c.active !== false && !isPaused(c, date))),
    [customers, date],
  );
  const byId = useMemo(() => Object.fromEntries(list.map((c) => [c.id, c])), [list]);
  const [skipped, setSkipped] = useState({});
  const [history, setHistory] = useState([]); // [{id, m, e}] delivered this session, in order
  const [review, setReview] = useState(null); // {id, m, e} | null — re-editing a delivered customer

  // Hardware back button exits review mode first (before leaving delivery)
  useEffect(() => {
    if (!review) return;
    return pushBackHandler(() => setReview(null));
  }, [review]);

  const isDelivered = (c) => {
    const en = saved[c.id];
    return !!(en && !en.skip && (en.milkL || 0) > 0);
  };
  const remaining = list.filter((c) => !isDelivered(c) && !skipped[c.id]);
  const done = list.length - remaining.length;
  const current = review ? byId[review.id] : remaining[0];
  const canGoBack = history.length > 0;

  // Seed history from already-delivered customers (e.g. delivered on an older
  // version, or after an app restart) so Back works for them too.
  useEffect(() => {
    if (history.length === 0) {
      const seeded = list
        .filter(isDelivered)
        .map((c) => {
          const en = saved[c.id] || {};
          return { id: c.id, m: en.milkMorningL || 0, e: en.milkEveningL || 0, p: en.paneerKg || 0 };
        });
      if (seeded.length) setHistory(seeded);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const deliver = (c, raw) => {
    const entry = normaliseEntry(c, { ...raw, skip: false, note: '' }, settings);
    saveEntries(fb, date, { [c.id]: entry }, displayName);
    if (!review) setHistory((h) => [...h, { id: c.id, m: entry.milkMorningL, e: entry.milkEveningL, p: entry.paneerKg || 0 }]);
    setReview(null);
    // the live listener removes c from `remaining`, so the next customer appears
  };

  const goBack = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setReview(prev);
  };

  const deliverAllUsual = () => {
    const rows = {};
    remaining.forEach((c) => {
      rows[c.id] = normaliseEntry(
        c,
        { milkMorningL: usualMorning(c), milkEveningL: usualEvening(c), paneerKg: 0, skip: false, note: '' },
        settings,
      );
    });
    if (Object.keys(rows).length) saveEntries(fb, date, rows, displayName);
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
        {remaining.length > 0 && !review && (
          <button type="button" className="btn primary big" onClick={deliverAllUsual}>
            {t('markAllUsual')}
          </button>
        )}
      </header>
      {remaining.length === 0 && !review ? (
        <div className="center-screen">
          <h2>{t('deliveryDone')}</h2>
          <button type="button" className="btn primary big" onClick={onBack}>
            ← {t('back')}
          </button>
        </div>
      ) : (
        current && (
          <DeliveryCard
            key={current.id + (review ? '-review' : '')}
            c={current}
            initM={review ? review.m : usualMorning(current)}
            initE={review ? review.e : usualEvening(current)}
            initPaneer={review ? review.p || 0 : 0}
            onDelivered={(raw) => deliver(current, raw)}
            onSkip={() => {
              setReview(null);
              setSkipped((s) => ({ ...s, [current.id]: true }));
            }}
            onBack={goBack}
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
