// Register: each customer card shows the name and the last 7 days (date + milk). Tapping a card
// opens a calendar with date-wise milk; tapping a date there opens the day editor for that
// customer. Daily entry happens in Delivery mode; "Edit this day" corrects any past day.
import { firstDeliveryMonth } from '../firstMonth.js';
import { useMemo, useState, useEffect } from 'react';
import { useLang } from '../i18n.js';
import DayEditor, { sortCustomers, isPaused, matchesQuery } from './Register.jsx';
import { addDays, dmy, fmtQty, timeHM, todayISO, monthName as fmtMonthName, shortDate, weekdaysMonFirst } from '../format.js';
import { toMilli } from '../billing.js';
import { pushBackHandler } from '../backStack.js';
import { useScrollKeep } from '../scrollKeep.js';
import { dayFilled, lockedBy } from '../reminders.js';

export { sortCustomers, isPaused };

/** Last 7 ISO dates ending on `date` (newest first, so today is always visible). */
function last7(date) {
  const out = [];
  for (let i = 0; i <= 6; i++) out.push(addDays(date, -i));
  return out;
}

function entryOn(days, cid, iso) {
  return (days[iso] && days[iso].entries && days[iso].entries[cid]) || null;
}

function milkOn(days, cid, iso) {
  const en = entryOn(days, cid, iso);
  return en && !en.skip ? (en.milkL || 0) : 0;
}

/** ✕ only for a day that was recorded with no milk (skip / 0 L), like the bill photo. A day with
    no entry at all (e.g. before the customer started) stays blank. */
export function isRecordedGap(days, cid, iso) {
  const en = entryOn(days, cid, iso);
  return !!en && milkOn(days, cid, iso) <= 0 && !(Number(en.paneerKg) > 0);
}

/** Calendar modal: month grid with each day's milk for one customer (read-only). */
function CalendarModal({ customer, days, onClose, onEditDay }) {
  const { t, lang } = useLang();
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

  // app language, not the WebView locale (was English on Hindi phones and vice versa)
  const monthName = fmtMonthName(ym, lang);
  const weekDays = weekdaysMonFirst(lang);
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
              <button
                type="button"
                key={i}
                disabled={c.iso > now}
                onClick={() => onEditDay(c.iso)}
                aria-label={dmy(c.iso, lang)}
                className={'cal-cell' + (c.iso === now ? ' today' : '') + (c.milk > 0 ? ' has' : '')}
              >
                <span className="cal-d">{c.d}</span>
                {c.milk > 0 ? (
                  <span className="cal-m">{fmtQty(c.milk)}</span>
                ) : isRecordedGap(days, customer.id, c.iso) ? (
                  <span className="cal-x">✕</span>
                ) : null}
              </button>
            ) : (
              <span key={i} />
            ),
          )}
        </div>
        <p className="muted small">
          {t('monthTotal')}: <b>{fmtQty(monthTotal)} {t('litre')}</b>
        </p>
        <p className="muted small">✏️ {t('tapDayToEdit')}</p>
      </div>
    </div>
  );
}

export default function RegisterView({ fb, customers, days, pendingDays, settings, displayName, onDelivery, onImportReview }) {
  const { t, lang } = useLang();
  const [date, setDate] = useState(todayISO());
  const [query, setQuery] = useState('');
  // Phone Back while a search is typed clears the search first (instead of leaving the tab).
  const hasQuery = String(query || '').trim() !== '';
  useEffect(() => (hasQuery ? pushBackHandler(() => setQuery('')) : undefined), [hasQuery]); // eslint-disable-line react-hooks/exhaustive-deps
  const [calId, setCalId] = useState(null);
  const [editing, setEditing] = useState(null); // { date, customerId? } — day editor open
  useScrollKeep(!!editing);

  // Hardware back button closes the calendar modal first
  useEffect(() => {
    if (!calId) return;
    return pushBackHandler(() => setCalId(null));
  }, [calId]);

  const day = days[date] || null;
  const active = useMemo(() => sortCustomers(customers.filter((c) => c.active !== false)), [customers]);
  const byId = useMemo(() => Object.fromEntries(customers.map((c) => [c.id, c])), [customers]);
  const week = useMemo(() => last7(date), [date]);

  const minDate = useMemo(() => firstDeliveryMonth(days) + '-01', [days]);
  const changeDate = (d) => setDate(d > todayISO() ? todayISO() : d < minDate ? minDate : d);

  const visible = active.filter((c) => matchesQuery(c, query));

  // From 08:00, today stays locked while yesterday's register is empty (reminders.js).
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(id);
  }, []);
  const isToday = date === todayISO();
  const lockAll = lockedBy({ now, days, pendingDays, hasCustomers: active.length > 0 });
  const lockDay = isToday ? lockAll : null;
  // "Edit this day" only while nobody has an entry on that day; after that, "Edit old records".
  const dayHasEntries = dayFilled(days, pendingDays, date);

  // Day total = milk delivered to customers. Supplier rows are milk bought, not sold.
  let totalMl = 0;
  active.forEach((c) => {
    if (!c.isSupplier) totalMl += toMilli(milkOn(days, c.id, date));
  });

  const calCustomer = calId ? byId[calId] : null;

  if (editing) {
    return (
      <DayEditor
        fb={fb}
        customers={customers}
        days={days}
        pendingDays={pendingDays}
        settings={settings}
        displayName={displayName}
        date={editing.date}
        customerId={editing.customerId}
        lockDate={!editing.oldRecords}
        maxDate={lockAll || undefined}
        minDate={minDate}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="screen register">
      <header className="screen-head">
        <h1>{date === todayISO() ? t('registerTitle') : dmy(date, lang)}</h1>
        <div className="date-nav">
          <button className="btn icon" disabled={date <= minDate} onClick={() => changeDate(addDays(date, -1))} aria-label={t('prevDay')}>
            ◀
          </button>
          <label className="date-pick">
            <span>{dmy(date, lang)}</span>
            <input
              type="date"
              value={date}
              min={minDate}
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
        <div className="day-total-row">
          <p className="day-total">
            {t('dayTotal')}: <b>{fmtQty(totalMl / 1000)} {t('litre')}</b>
          </p>
          {/* Any other day: the editor opens on the day before, with ◀ ▶ to move between days. */}
          <button
            type="button"
            className="btn small"
            onClick={() => {
              const prev = addDays(date, -1);
              setEditing({ date: prev >= minDate ? prev : date, oldRecords: true });
            }}
          >
            🗂️ {t('editOldRecords')}
          </button>
        </div>
        {lockDay && (
          <div className="card warn lock-card" data-testid="lock-card">
            <p>🔒 {t('lockedYesterday').replace('{date}', dmy(lockDay, lang))}</p>
            <button type="button" className="btn primary" onClick={() => setEditing({ date: lockDay })}>
              ✏️ {t('fillYesterday')}
            </button>
          </div>
        )}
        {onDelivery && (
          <button type="button" className="btn primary big delivery-cta" disabled={!!lockDay} onClick={onDelivery}>
            🚚 {t('delivery')}
          </button>
        )}
        {onImportReview && (
          <button type="button" className="btn big delivery-cta" onClick={onImportReview}>
            📥 {t('importReviewTitle')}
          </button>
        )}
        <button type="button" className="btn big delivery-cta" disabled={!!lockDay || dayHasEntries} onClick={() => setEditing({ date })}>
          ✏️ {t('editDay')} ({dmy(date, lang)})
        </button>
        {dayHasEntries && <p className="muted small">{t('editDayDone')}</p>}
      </header>

      {!settings.milkRatePaise && <p className="card warn small">{t('rateMissing')}</p>}
      {active.length === 0 && <p className="empty">{t('noCustomers')}</p>}
      {active.length > 0 && visible.length === 0 && <p className="empty">{t('noResults')}</p>}

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
                    {c.isSupplier && <span className="tag supplier-tag">🏷️ {t('supplier')}</span>}
                  </div>
                  <span className="muted small">{fmtQty(milkOn(days, c.id, date))} {t('litre')}</span>
                </div>
                <div className="week-strip">
                  {week.map((iso) => {
                    const mv = milkOn(days, c.id, iso);
                    return (
                      <div key={iso} className={'wk' + (iso === date ? ' cur' : '')}>
                        <span className="wk-d">{shortDate(iso, lang).replace(' ', '\n')}</span>
                        {mv > 0 ? (
                          <span className="wk-m">{fmtQty(mv)}</span>
                        ) : isRecordedGap(days, c.id, iso) ? (
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
        <CalendarModal
          customer={calCustomer}
          days={days}
          onClose={() => setCalId(null)}
          onEditDay={(iso) => {
            if (lockAll && iso === todayISO()) return; // fill yesterday first
            setCalId(null);
            setEditing({ date: iso, customerId: calCustomer.id });
          }}
        />
      )}
    </div>
  );
}
