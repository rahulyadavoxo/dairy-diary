// Register is now a read-only view: each customer card shows the name and the
// last 7 days (date + milk). Tapping a card opens a calendar with date-wise milk.
// Entry happens in Delivery mode (the only button at the top).
import { useMemo, useState, useEffect } from 'react';
import { useLang } from '../i18n.js';
import { sortCustomers, isPaused } from './Register.jsx';
import { addDays, dmy, fmtQty, timeHM, todayISO } from '../format.js';
import { toMilli } from '../billing.js';
import { pushBackHandler } from '../backStack.js';

export { sortCustomers, isPaused };

/** Last 7 ISO dates ending on `date` (newest first, so today is always visible). */
function last7(date) {
  const out = [];
  for (let i = 0; i <= 6; i++) out.push(addDays(date, -i));
  return out;
}

/** "13 Oct" style short date. */
function shortDate(iso) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${months[m - 1]}`;
}

function milkOn(days, cid, iso) {
  const en = days[iso] && days[iso].entries && days[iso].entries[cid];
  return en && !en.skip ? (en.milkL || 0) : 0;
}

/** Calendar modal: month grid with each day's milk for one customer (read-only). */
function CalendarModal({ customer, days, onClose }) {
  const { t } = useLang();
  const now = todayISO();
  const [ym, setYm] = useState(now.slice(0, 7)); // "2026-10"
  const [y, m] = ym.split('-').map(Number);

  const cells = useMemo(() => {
    const first = new Date(y, m - 1, 1);
    const startDay = (first.getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(y, m, 0).getDate();
    const arr = [];
    for (let i = 0; i < startDay; i++) arr.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      arr.push({ iso, d, milk: milkOn(days, customer.id, iso) });
    }
    return arr;
  }, [y, m, days, customer.id]);

  const shift = (delta) => {
    const d = new Date(y, m - 1 + delta, 1);
    const nym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (nym <= now.slice(0, 7)) setYm(nym);
  };

  const monthName = new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const weekDays = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  let monthTotal = 0;
  cells.forEach((c) => {
    if (c) monthTotal += c.milk;
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{customer.name}</b>
          <button type="button" className="btn small ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="cal-nav">
          <button type="button" className="btn icon" onClick={() => shift(-1)}>
            ◀
          </button>
          <b>{monthName}</b>
          <button type="button" className="btn icon" onClick={() => shift(1)} disabled={ym >= now.slice(0, 7)}>
            ▶
          </button>
        </div>
        <div className="cal-grid">
          {weekDays.map((w, i) => (
            <span key={i} className="cal-wd">
              {w}
            </span>
          ))}
          {cells.map((c, i) =>
            c ? (
              <div key={i} className={'cal-cell' + (c.iso === now ? ' today' : '') + (c.milk > 0 ? ' has' : '')}>
                <span className="cal-d">{c.d}</span>
                {c.milk > 0 ? (
                  <span className="cal-m">{fmtQty(c.milk)}</span>
                ) : c.iso < now ? (
                  <span className="cal-x">✕</span>
                ) : null}
              </div>
            ) : (
              <span key={i} />
            ),
          )}
        </div>
        <p className="muted small">
          {t('monthTotal')}: <b>{fmtQty(monthTotal)} {t('litre')}</b>
        </p>
      </div>
    </div>
  );
}

export default function RegisterView({ fb, customers, days, pendingDays, settings, displayName, onDelivery, onImportReview }) {
  const { t } = useLang();
  const [date, setDate] = useState(todayISO());
  const [query, setQuery] = useState('');
  const [calId, setCalId] = useState(null);

  // Hardware back button closes the calendar modal first
  useEffect(() => {
    if (!calId) return;
    return pushBackHandler(() => setCalId(null));
  }, [calId]);

  const day = days[date] || null;
  const active = useMemo(() => sortCustomers(customers.filter((c) => c.active !== false)), [customers]);
  const byId = useMemo(() => Object.fromEntries(customers.map((c) => [c.id, c])), [customers]);
  const week = useMemo(() => last7(date), [date]);

  const changeDate = (d) => setDate(d > todayISO() ? todayISO() : d);

  const q = query.trim().toLowerCase();
  const visible = q
    ? active.filter((c) => [c.name, c.area, c.phone].some((v) => String(v || '').toLowerCase().includes(q)))
    : active;

  let totalMl = 0;
  active.forEach((c) => {
    totalMl += toMilli(milkOn(days, c.id, date));
  });

  const calCustomer = calId ? byId[calId] : null;

  return (
    <div className="screen register">
      <header className="screen-head">
        <h1>{date === todayISO() ? t('registerTitle') : dmy(date)}</h1>
        <div className="date-nav">
          <button className="btn icon" onClick={() => changeDate(addDays(date, -1))} aria-label={t('prevDay')}>
            ◀
          </button>
          <label className="date-pick">
            <span>{dmy(date)}</span>
            <input
              type="date"
              value={date}
              max={todayISO()}
              onChange={(e) => {
                const v = e.target.value;
                if (v) changeDate(v);
              }}
            />
          </label>
          <button className="btn icon" disabled={date === todayISO()} onClick={() => changeDate(addDays(date, 1))} aria-label={t('nextDay')}>
            ▶
          </button>
          {date !== todayISO() && (
            <button className="btn small" onClick={() => changeDate(todayISO())}>
              {t('today')}
            </button>
          )}
        </div>
        <p className="muted small">
          {day && day.lastEditedBy ? `${t('lastEdited')}: ${day.lastEditedBy}, ${timeHM(day.lastEditedAt)}` : t('nobodyYet')}
          {pendingDays[date] ? ` · ${t('pendingSync')}` : day ? ` · ${t('synced')}` : ''}
        </p>
        <input className="search" type="search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <p className="day-total">
          {t('dayTotal')}: <b>{fmtQty(totalMl / 1000)} {t('litre')}</b>
        </p>
        {onDelivery && (
          <button type="button" className="btn primary big delivery-cta" onClick={onDelivery}>
            🚚 {t('delivery')}
          </button>
        )}
        {onImportReview && (
          <button type="button" className="btn big delivery-cta" onClick={onImportReview}>
            📥 {t('importReviewTitle')}
          </button>
        )}
      </header>

      {!settings.milkRatePaise && <p className="card warn small">{t('rateMissing')}</p>}
      {active.length === 0 && <p className="empty">{t('noCustomers')}</p>}

      <ul className="rows">
        {visible.map((c) => {
          const num = active.findIndex((a) => a.id === c.id) + 1;
          const en = days[date] && days[date].entries && days[date].entries[c.id];
          const has = en && !en.skip && (en.milkL || 0) > 0;
          return (
            <li key={c.id}>
              <button type="button" className="card cust-card" onClick={() => setCalId(c.id)}>
                <div className="row-top">
                  <div className="who">
                    <span className={'dot ' + (has ? 'synced' : 'unsaved')} />
                    <b>{num}. {c.name}</b>
                    {c.area && <span className="muted small"> · {c.area}</span>}
                    {isPaused(c, date) && <span className="tag">{t('paused')}</span>}
                  </div>
                  <span className="muted small">{fmtQty(milkOn(days, c.id, date))} {t('litre')}</span>
                </div>
                <div className="week-strip">
                  {week.map((iso) => {
                    const mv = milkOn(days, c.id, iso);
                    const isPast = iso < todayISO();
                    return (
                      <div key={iso} className={'wk' + (iso === date ? ' cur' : '')}>
                        <span className="wk-d">{shortDate(iso)}</span>
                        {mv > 0 ? (
                          <span className="wk-m">{fmtQty(mv)}</span>
                        ) : isPast ? (
                          <span className="wk-x">✕</span>
                        ) : (
                          <span className="wk-m">–</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </button>
            </li>
          );
        })}
      </ul>

      {calCustomer && (
        <CalendarModal customer={calCustomer} days={days} onClose={() => setCalId(null)} />
      )}
    </div>
  );
}
