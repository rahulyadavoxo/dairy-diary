// Day editor: correct any past day (or today) for every customer, or for one customer.
// Opened from the Register tab ("Edit this day") and from a customer's calendar (tap a date).
// Rows: milk for the chosen session (morning / evening / total), skip, paneer, note. Edits
// autosave after a short pause and are flushed when the editor closes or the date changes.
import { useEffect, useMemo, useRef, useState } from 'react';
import { saveFeedback } from '../feedback.js';
import { useLang } from '../i18n.js';
import { saveEntries } from '../db.js';
import { toMilli } from '../billing.js';
import { normaliseEntry, usualMorning, usualEvening } from '../entry.js';
import { addDays, dmy, fmtQty, timeHM, todayISO } from '../format.js';
import { pushBackHandler } from '../backStack.js';

export function sortCustomers(list) {
  return [...list].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || String(a.name || '').localeCompare(String(b.name || '')));
}

export function isPaused(c, date) {
  if (!c.pauseFrom && !c.pauseTo) return false;
  const from = c.pauseFrom || '0000-00-00';
  const to = c.pauseTo || '9999-12-31';
  return date >= from && date <= to;
}

/** Search: name / area as text; the phone by digits only ("98765 43210" finds 9876543210). */
export function matchesQuery(c, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  if ([c.name, c.area].some((v) => String(v || '').toLowerCase().includes(q))) return true;
  const qd = q.replace(/\D/g, '');
  return qd.length > 0 && qd.length === q.replace(/[\s+()-]/g, '').length && String(c.phone || '').replace(/\D/g, '').includes(qd);
}

/** Suggestion for a customer with no entry that day: the usual morning / evening litres. */
function defaultRow(c, date) {
  const m = usualMorning(c);
  const e = usualEvening(c);
  return { milkL: Math.round((m + e) * 1000) / 1000, milkMorningL: m, milkEveningL: e, paneerKg: 0, skip: isPaused(c, date), note: '' };
}

export const SESSION_KEY = 'dd_session';
export function defaultSession() {
  try {
    const s = localStorage.getItem(SESSION_KEY);
    if (s === 'morning' || s === 'evening' || s === 'total') return s;
  } catch {
    /* ignore */
  }
  return new Date().getHours() < 13 ? 'morning' : 'evening';
}

const AUTOSAVE_MS = 1200;

export default function DayEditor({ fb, customers, days, pendingDays = {}, settings, displayName, date: initialDate, customerId, onClose }) {
  const { t } = useLang();
  const [date, setDate] = useState(() => (initialDate && initialDate <= todayISO() ? initialDate : todayISO()));
  const [drafts, setDrafts] = useState({});
  const [query, setQuery] = useState('');
  const [openPaneer, setOpenPaneer] = useState({});
  const [flash, setFlash] = useState('');
  const [session, setSession] = useState(defaultSession);
  const dirty = useRef({}); // cid -> row awaiting autosave
  const timer = useRef(null);
  const ctx = useRef({});

  const pickSession = (s) => {
    setSession(s);
    try {
      localStorage.setItem(SESSION_KEY, s);
    } catch {
      /* ignore */
    }
  };

  const day = days[date] || null;
  const saved = (day && day.entries) || {};
  const active = useMemo(
    () => (customerId ? customers.filter((c) => c.id === customerId) : sortCustomers(customers.filter((c) => c.active !== false))),
    [customers, customerId],
  );
  const byId = useMemo(() => Object.fromEntries(customers.map((c) => [c.id, c])), [customers]);

  const rowFor = (c) => drafts[c.id] || saved[c.id] || defaultRow(c, date);

  const normalise = (c, r, st) => normaliseEntry(c, r, st);

  ctx.current = { date, displayName, byId, settings };

  const flush = () => {
    clearTimeout(timer.current);
    const { date: d, displayName: who, byId: map, settings: st } = ctx.current;
    const rows = dirty.current;
    const ids = Object.keys(rows);
    if (!ids.length) return;
    const out = {};
    ids.forEach((id) => {
      if (map[id]) out[id] = normalise(map[id], rows[id], st);
    });
    dirty.current = {};
    saveEntries(fb, d, out, who);
    setDrafts((prev) => {
      const n = { ...prev };
      ids.forEach((id) => delete n[id]);
      return n;
    });
    setFlash(navigator.onLine ? t('saved') : t('savedOffline'));
    setTimeout(() => setFlash(''), 2500);
  };

  // flush pending edits when leaving the screen or changing date
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    flush();
    onClose();
  };
  // Hardware back closes the editor (after saving pending edits), not the whole Register tab.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => pushBackHandler(() => closeRef.current()), []);

  const changeDate = (d) => {
    flush();
    setDrafts({});
    setOpenPaneer({});
    setDate(d);
  };

  const update = (c, patch) => {
    const next = { ...rowFor(c), ...patch };
    setDrafts((prev) => ({ ...prev, [c.id]: next }));
    dirty.current[c.id] = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_MS);
  };

  /** Write a quantity into the active session field, keeping milkL (= total) in sync. */
  const updateQty = (c, v) => {
    const r = rowFor(c);
    const val = Math.max(0, toMilli(v) / 1000);
    if (session === 'morning') {
      const e = toMilli(r.milkEveningL) / 1000;
      update(c, { milkMorningL: val, milkL: Math.round((val + e) * 1000) / 1000 });
    } else if (session === 'evening') {
      const m = toMilli(r.milkMorningL) / 1000;
      update(c, { milkEveningL: val, milkL: Math.round((m + val) * 1000) / 1000 });
    } else {
      // Total mode: sessions not tracked (null), milkL is the whole day's quantity.
      update(c, { milkL: val, milkMorningL: null, milkEveningL: null });
    }
  };

  const qtyFor = (r) => (session === 'morning' ? r.milkMorningL || 0 : session === 'evening' ? r.milkEveningL || 0 : r.milkL);

  const saveAll = () => {
    // Rows without a saved entry only show the usual litres as a suggestion. Saving them creates
    // entries (= bills) for that day, so ask first when editing the whole day.
    const fresh = active.filter((c) => !saved[c.id] && !drafts[c.id]).length;
    if (!customerId && fresh > 0 && !window.confirm(t('saveAllConfirm').replace('{n}', fresh))) return;
    active.forEach((c) => {
      dirty.current[c.id] = rowFor(c);
    });
    flush();
    saveFeedback(true);
  };

  const visible = active.filter((c) => matchesQuery(c, query));

  // Day total = milk sold to customers, from saved / edited rows only (suggestions are not
  // deliveries; supplier rows are milk bought, not sold).
  let totalMl = 0;
  let totalPaneerG = 0;
  active.forEach((c) => {
    if (c.isSupplier || !(drafts[c.id] || saved[c.id])) return;
    const r = rowFor(c);
    if (!r.skip) totalMl += toMilli(r.milkL);
    totalPaneerG += toMilli(r.paneerKg);
  });

  const unsavedCount = active.filter((c) => drafts[c.id]).length;

  const only = customerId ? active[0] : null;

  return (
    <div className="full-overlay" data-testid="day-editor">
      <div className="screen register">
        <header className="screen-head">
          <button type="button" className="btn small ghost" onClick={close}>
            ← {t('back')}
          </button>
          <h1>
            ✏️ {only ? only.name : t('editDayTitle')} · {dmy(date)}
          </h1>
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
                  if (v) changeDate(v > todayISO() ? todayISO() : v);
                }}
              />
            </label>
            <button
              className="btn icon"
              disabled={date >= todayISO()}
              onClick={() => {
                const n = addDays(date, 1);
                if (n <= todayISO()) changeDate(n);
              }}
              aria-label={t('nextDay')}
            >
              ▶
            </button>
          </div>
          <p className="muted small">
            {day && day.lastEditedBy ? `${t('lastEdited')}: ${day.lastEditedBy}, ${timeHM(day.lastEditedAt)}` : t('nobodyYet')}
            {pendingDays[date] ? ` · ${t('pendingSync')}` : day ? ` · ${t('synced')}` : ''}
          </p>
          {!only && (
            <input className="search" type="search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
          {!only && (
            <p className="day-total">
              {t('dayTotal')}: <b>{fmtQty(totalMl / 1000)} {t('litre')}</b>
              {totalPaneerG > 0 && (
                <>
                  {' '}
                  · {t('paneer')}: <b>{fmtQty(totalPaneerG / 1000)} {t('kg')}</b>
                </>
              )}
            </p>
          )}
          <div className="chips session-chips" role="tablist" aria-label={t('session')}>
            {['morning', 'evening', 'total'].map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={session === s}
                className={'btn chip' + (session === s ? ' on' : '')}
                onClick={() => pickSession(s)}
              >
                {t('session_' + s)}
              </button>
            ))}
          </div>
          <p className="muted small">{t('editDayHint')}</p>
        </header>

      {!settings.milkRatePaise && <p className="card warn small">{t('rateMissing')}</p>}
      {active.length === 0 && <p className="empty">{t('noCustomers')}</p>}
      {active.length > 0 && visible.length === 0 && <p className="empty">{t('noResults')}</p>}

      <ul className="rows">
        {visible.map((c) => {
          const r = rowFor(c);
          const s = saved[c.id];
          const status = drafts[c.id] || !s ? 'unsaved' : pendingDays[date] ? 'pending' : 'synced';
          const showPaneer = openPaneer[c.id] || Number(r.paneerKg) > 0;
          return (
            <li key={c.id} className={'row' + (r.skip ? ' skipped' : '')}>
              <div className="row-top">
                <div className="who">
                  <span className={'dot ' + status} title={status === 'unsaved' ? t('notSavedYet') : status === 'pending' ? t('pendingSync') : t('synced')} />
                  <b>{c.name}</b>
                  {c.area && <span className="muted small"> · {c.area}</span>}
                  {isPaused(c, date) && <span className="tag">{t('paused')}</span>}
                  {c.isSupplier && <span className="tag supplier-tag">🏷️ {t('supplier')}</span>}
                  {s && s.updatedBy && <span className="muted tiny"> · {s.updatedBy}</span>}
                </div>
                <button className={'btn toggle' + (r.skip ? ' on' : '')} onClick={() => update(c, { skip: !r.skip })}>
                  {r.skip ? t('skipped') : t('skip')}
                </button>
              </div>
              <div className="row-controls">
                <div className="stepper">
                  <button className="btn step" disabled={r.skip} onClick={() => updateQty(c, (toMilli(qtyFor(r)) - 250) / 1000)}>
                    −
                  </button>
                  <input
                    className="qty"
                    type="number"
                    inputMode="decimal"
                    step="0.25"
                    min="0"
                    disabled={r.skip}
                    value={qtyFor(r)}
                    onChange={(e) => updateQty(c, e.target.value)}
                  />
                  <span className="unit">{t('litre')}</span>
                  <button className="btn step" disabled={r.skip} onClick={() => updateQty(c, (toMilli(qtyFor(r)) + 250) / 1000)}>
                    +
                  </button>
                </div>
                {showPaneer ? (
                  <label className="paneer">
                    {t('paneer')}
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.25"
                      min="0"
                      value={r.paneerKg || ''}
                      placeholder="0"
                      onChange={(e) => update(c, { paneerKg: e.target.value })}
                    />
                    {t('kg')}
                  </label>
                ) : (
                  <button className="btn small ghost" onClick={() => setOpenPaneer({ ...openPaneer, [c.id]: true })}>
                    + {t('paneer')}
                  </button>
                )}
                <button
                  className={'btn small ghost' + (r.note ? ' has-note' : '')}
                  onClick={() => {
                    const v = window.prompt(t('note'), r.note || '');
                    if (v !== null) update(c, { note: v });
                  }}
                  aria-label={t('note')}
                >
                  📝
                </button>
              </div>
              {r.note && <div className="note muted small">📝 {r.note}</div>}
            </li>
          );
        })}
      </ul>

      <div className="savebar">
        <span className="small">{flash || (unsavedCount ? `${t('notSavedYet')}: ${unsavedCount}` : t('saved'))}</span>
        <button className="btn primary big" onClick={saveAll} disabled={!active.length}>
          {only ? t('save') : t('saveAll')}
        </button>
      </div>
      </div>
    </div>
  );
}
