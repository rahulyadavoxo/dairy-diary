import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../i18n.js';
import { saveEntries } from '../db.js';
import { milkRateFor, paneerRateFor, toMilli } from '../billing.js';
import { addDays, dmy, fmtQty, timeHM, todayISO } from '../format.js';

export function sortCustomers(list) {
  return [...list].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || String(a.name || '').localeCompare(String(b.name || '')));
}

export function isPaused(c, date) {
  if (!c.pauseFrom && !c.pauseTo) return false;
  const from = c.pauseFrom || '0000-00-00';
  const to = c.pauseTo || '9999-12-31';
  return date >= from && date <= to;
}

function defaultRow(c, date) {
  return { milkL: Number(c.usualL) || 0, paneerKg: 0, skip: isPaused(c, date), note: '' };
}

const AUTOSAVE_MS = 1200;

export default function Register({ fb, customers, days, pendingDays, settings, displayName }) {
  const { t } = useLang();
  const [date, setDate] = useState(todayISO());
  const [drafts, setDrafts] = useState({});
  const [query, setQuery] = useState('');
  const [openPaneer, setOpenPaneer] = useState({});
  const [flash, setFlash] = useState('');
  const dirty = useRef({}); // cid -> row awaiting autosave
  const timer = useRef(null);
  const ctx = useRef({});

  const day = days[date] || null;
  const saved = (day && day.entries) || {};
  const active = useMemo(() => sortCustomers(customers.filter((c) => c.active !== false)), [customers]);
  const byId = useMemo(() => Object.fromEntries(customers.map((c) => [c.id, c])), [customers]);

  const rowFor = (c) => drafts[c.id] || saved[c.id] || defaultRow(c, date);

  const normalise = (c, r, st) => ({
    milkL: Math.max(0, toMilli(r.milkL) / 1000),
    paneerKg: Math.max(0, toMilli(r.paneerKg) / 1000),
    skip: !!r.skip,
    note: r.note || '',
    milkRatePaise: milkRateFor(c, st, null),
    paneerRatePaise: paneerRateFor(st, null),
  });

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

  const saveAll = () => {
    active.forEach((c) => {
      dirty.current[c.id] = rowFor(c);
    });
    flush();
  };

  const q = query.trim().toLowerCase();
  const visible = q
    ? active.filter((c) => [c.name, c.area, c.phone].some((v) => String(v || '').toLowerCase().includes(q)))
    : active;

  let totalMl = 0;
  let totalPaneerG = 0;
  active.forEach((c) => {
    const r = rowFor(c);
    if (!r.skip) totalMl += toMilli(r.milkL);
    totalPaneerG += toMilli(r.paneerKg);
  });

  const unsavedCount = active.filter((c) => !saved[c.id] || drafts[c.id]).length;

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
            <input type="date" value={date} onChange={(e) => e.target.value && changeDate(e.target.value)} />
          </label>
          <button className="btn icon" onClick={() => changeDate(addDays(date, 1))} aria-label={t('nextDay')}>
            ▶
          </button>
          {date !== todayISO() && (
            <button className="btn small" onClick={() => changeDate(todayISO())}>
              {t('today')}
            </button>
          )}
        </div>
        <p className="muted small">
          {day && day.lastEditedBy
            ? `${t('lastEdited')}: ${day.lastEditedBy}, ${timeHM(day.lastEditedAt)}`
            : t('nobodyYet')}
          {pendingDays[date] ? ` · ${t('pendingSync')}` : day ? ` · ${t('synced')}` : ''}
        </p>
        <input className="search" type="search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <p className="day-total">
          {t('dayTotal')}: <b>{fmtQty(totalMl / 1000)} {t('litre')}</b>
          {totalPaneerG > 0 && (
            <>
              {' '}
              · {t('paneer')}: <b>{fmtQty(totalPaneerG / 1000)} {t('kg')}</b>
            </>
          )}
        </p>
      </header>

      {!settings.milkRatePaise && <p className="card warn small">{t('rateMissing')}</p>}
      {active.length === 0 && <p className="empty">{t('noCustomers')}</p>}

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
                  {s && s.updatedBy && <span className="muted tiny"> · {s.updatedBy}</span>}
                </div>
                <button className={'btn toggle' + (r.skip ? ' on' : '')} onClick={() => update(c, { skip: !r.skip })}>
                  {r.skip ? t('skipped') : t('skip')}
                </button>
              </div>
              <div className="row-controls">
                <div className="stepper">
                  <button className="btn step" disabled={r.skip} onClick={() => update(c, { milkL: Math.max(0, (toMilli(r.milkL) - 500) / 1000) })}>
                    −
                  </button>
                  <input
                    className="qty"
                    type="number"
                    inputMode="decimal"
                    step="0.5"
                    min="0"
                    disabled={r.skip}
                    value={r.milkL}
                    onChange={(e) => update(c, { milkL: e.target.value })}
                  />
                  <span className="unit">{t('litre')}</span>
                  <button className="btn step" disabled={r.skip} onClick={() => update(c, { milkL: (toMilli(r.milkL) + 500) / 1000 })}>
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
          {t('saveAll')}
        </button>
      </div>
    </div>
  );
}
