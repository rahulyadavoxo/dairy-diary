import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../i18n.js';
import { saveCustomer, saveOrder, entryChanges } from '../db.js';
import { sortCustomers, isPaused, matchesQuery } from './Register.jsx';
import { dmy, fmtQty, paiseToInput, rupees, toPaise, todayISO } from '../format.js';
import { pushBackHandler } from '../backStack.js';
import ImportCustomers from './ImportCustomers.jsx';
import { usualMorning, usualEvening } from '../entry.js';
import { useScrollKeep } from '../scrollKeep.js';
import { saveFeedback } from '../feedback.js';
import { getPinHash, verifyPin, pinWaitSeconds } from '../pinLock.js';
import StickySearch from '../components/StickySearch.jsx';

// The customer saved last stays lightly green in the list (on this phone) until another is saved.
const LAST_EDITED_KEY = 'dd_last_edited_customer';
export function loadLastEdited() {
  try {
    return localStorage.getItem(LAST_EDITED_KEY) || '';
  } catch {
    return '';
  }
}
function storeLastEdited(id) {
  try {
    if (id) localStorage.setItem(LAST_EDITED_KEY, id);
  } catch {
    /* ignore */
  }
}

const EMPTY = { name: '', phone: '', area: '', usualMorningL: 0.5, usualEveningL: 0.5, customRate: false, rateOverride: '', customPaneerRate: false, paneerRateOverride: '', openingDue: '', openingAdv: false, pauseFrom: '', pauseTo: '', active: true, isSupplier: false, prefillMode: 'usual' };

const round3 = (n) => Math.max(0, Math.round(Number(n || 0) * 1000) / 1000);

export { usualMorning, usualEvening }; // moved to entry.js (also used by the day editor)

/** Pause label for the list: only a current or upcoming pause (an old one is just history). */
export function pauseLabel(c, today, t, lang = 'en') {
  if (!c.pauseFrom && !c.pauseTo) return '';
  if (isPaused(c, today)) return c.pauseTo ? `${t('paused')} → ${dmy(c.pauseTo, lang)}` : t('paused');
  if (c.pauseFrom && c.pauseFrom > today) return `${t('pauseScheduled')} ${dmy(c.pauseFrom, lang)}${c.pauseTo ? '–' + dmy(c.pauseTo, lang) : ''}`;
  return '';
}

// Search text survives the edit form and the ₹ detail screen (which unmounts this screen).
const view = { query: '' };
export function resetCustomersView() {
  view.query = '';
}

export default function Customers({ fb, customers, settings, openCustomer }) {
  const { t, lang } = useLang();
  const [editing, setEditing] = useState(null); // null | 'new' | customer
  const [importing, setImporting] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState({});
  const [lastEdited, setLastEdited] = useState(loadLastEdited);
  const [query, setQueryState] = useState(() => view.query);
  const setQuery = (v) => {
    view.query = v;
    setQueryState(v);
  };
  const searching = query.trim() !== '';
  // Phone Back while a search is typed clears the search first (instead of leaving the tab).
  const hasQuery = String(query || '').trim() !== '';
  useEffect(() => (hasQuery ? pushBackHandler(() => setQuery('')) : undefined), [hasQuery]); // eslint-disable-line react-hooks/exhaustive-deps
  useScrollKeep(!!editing || importing);
  const sorted = useMemo(() => sortCustomers(customers), [customers]);
  const active = sorted.filter((c) => c.active !== false);
  const inactive = sorted.filter((c) => c.active === false);

  const move = (idx, dir) => {
    const list = [...active];
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j], list[idx]];
    saveOrder(fb, [...list, ...inactive]);
  };

  const toggleSelect = (id) => setSelected((s) => ({ ...s, [id]: !s[id] }));
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);
  // Hardware back closes the open sub-screen (form / bulk add) instead of leaving the tab.
  useEffect(() => (editing ? pushBackHandler(() => setEditing(null)) : undefined), [editing]);
  useEffect(() => (importing ? pushBackHandler(() => setImporting(false)) : undefined), [importing]);

  const tagSelected = (val) => {
    selectedIds.forEach((id) => saveCustomer(fb, id, { isSupplier: val }));
    setSelected({});
    setSelecting(false);
  };

  if (importing) {
    return <ImportCustomers fb={fb} customers={customers} onDone={() => setImporting(false)} />;
  }

  if (editing) {
    return (
      <CustomerForm
        fb={fb}
        initial={editing === 'new' ? null : editing}
        nextOrder={(active.length + inactive.length + 1) * 10}
        settings={settings}
        onDone={(savedId) => {
          if (savedId) {
            storeLastEdited(savedId);
            setLastEdited(savedId);
          }
          setEditing(null);
        }}
      />
    );
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>
          {t('customersTitle')} <span className="muted small">({active.length})</span>
        </h1>
        <div className="head-btns" data-testid="cust-head-btns">
          <button className="btn primary" onClick={() => setEditing('new')}>
            + {t('addCustomer')}
          </button>
          <button className="btn" onClick={() => setImporting(true)}>
            ⇪ {t('importTitle')}
          </button>
          <button className="btn" onClick={() => { setSelecting(!selecting); setSelected({}); }}>
            {selecting ? t('cancel') : t('selectTag')}
          </button>
        </div>
      </header>
      <StickySearch>
        <input
          className="search"
          type="search"
          placeholder={t('search')}
          aria-label={t('search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </StickySearch>
      <p className="muted small">{searching ? t('routeOrderSearch') : `${t('routeOrder')}: ▲ / ▼`}</p>
      {selecting && selectedIds.length > 0 && (
        <div className="select-bar">
          <span className="small">{selectedIds.length} {t('selected')}</span>
          <button className="btn primary small" onClick={() => tagSelected(true)}>
            🏷️ {t('tagSupplier')}
          </button>
          <button className="btn small" onClick={() => tagSelected(false)}>
            {t('untagSupplier')}
          </button>
        </div>
      )}
      {active.length === 0 && <p className="empty">{t('noCustomers')}</p>}
      {active.length > 0 && searching && !active.some((c) => matchesQuery(c, query)) && <p className="empty">{t('noMatch')}</p>}
      <ul className="rows">
        {active.map((c, i) => (searching && !matchesQuery(c, query) ? null : (
          <li key={c.id} className={'row cust-row' + (c.id === lastEdited ? ' last-edited' : '')} data-testid={c.id === lastEdited ? 'last-edited' : undefined}>
            {selecting ? (
              <input
                type="checkbox"
                className="select-check"
                checked={!!selected[c.id]}
                onChange={() => toggleSelect(c.id)}
                aria-label={c.name}
              />
            ) : (
              <div className="order-btns">
                <button className="btn step" disabled={searching || i === 0} onClick={() => move(i, -1)} aria-label={t('moveUp')}>
                  ▲
                </button>
                <button className="btn step" disabled={searching || i === active.length - 1} onClick={() => move(i, 1)} aria-label={t('moveDown')}>
                  ▼
                </button>
              </div>
            )}
            <button className="cust-main" onClick={() => (selecting ? toggleSelect(c.id) : setEditing(c))}>
              <b>
                {i + 1}. {c.name}
                {c.isSupplier && <span className="tag supplier-tag"> 🏷️ {t('supplier')}</span>}
              </b>
              <span className="muted small">
                {[c.area, c.phone].filter(Boolean).join(' · ')}
              </span>
              <span className="small">
                {fmtQty(c.usualL || 0)} {t('litre')}
                {c.rateOverridePaise ? ` · ${rupees(c.rateOverridePaise)}/${t('litre')}` : ''}
                {c.paneerRateOverridePaise ? ` · 🧀 ${rupees(c.paneerRateOverridePaise)}/${t('kg')}` : ''}
                {pauseLabel(c, todayISO(), t, lang) ? ` · ${pauseLabel(c, todayISO(), t, lang)}` : ''}
              </span>
            </button>
            <button className="btn small ghost" onClick={() => openCustomer(c.id)}>
              ₹
            </button>
          </li>
        )))}
      </ul>
      {inactive.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> {t('showInactive')} ({inactive.length})
        </label>
      )}
      {showInactive && (
        <ul className="rows">
          {inactive.filter((c) => matchesQuery(c, query)).map((c) => (
            <li key={c.id} className="row cust-row inactive">
              <button className="cust-main" onClick={() => setEditing(c)}>
                <b>{c.name}</b>
                <span className="muted small">{t('inactive')}</span>
              </button>
              <button className="btn small" onClick={() => saveCustomer(fb, c.id, { active: true, order: (active.length + 1) * 10 })}>
                {t('activate')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CustomerForm({ fb, initial, nextOrder, onDone }) {
  const { t } = useLang();
  const [f, setF] = useState(() =>
    initial
      ? {
          name: initial.name || '',
          phone: initial.phone || '',
          area: initial.area || '',
          usualL: initial.usualL ?? 1,
          usualMorningL: initial.usualMorningL ?? round3((Number(initial.usualL) || 0) / 2),
          usualEveningL: initial.usualEveningL ?? round3((Number(initial.usualL) || 0) / 2),
          customRate: Number.isInteger(initial.rateOverridePaise) && initial.rateOverridePaise > 0,
          rateOverride: paiseToInput(initial.rateOverridePaise),
          customPaneerRate: Number.isInteger(initial.paneerRateOverridePaise) && initial.paneerRateOverridePaise > 0,
          paneerRateOverride: paiseToInput(initial.paneerRateOverridePaise),
          // shown as a positive amount; the Due / Advance switch gives the sign (advance = negative)
          openingDue: paiseToInput(initial.openingDuePaise ? Math.abs(initial.openingDuePaise) : ''),
          openingAdv: (initial.openingDuePaise || 0) < 0,
          pauseFrom: initial.pauseFrom || '',
          pauseTo: initial.pauseTo || '',
          active: initial.active !== false,
          isSupplier: !!initial.isSupplier,
          prefillMode: initial.prefillMode === 'lastDay' ? 'lastDay' : 'usual',
        }
      : EMPTY,
  );
  const f0 = useRef(f); // the form as it opened: only fields changed since then are saved
  const [err, setErr] = useState('');
  // Deactivating a customer (the Deactivate button or turning Active off) asks for the PIN when
  // one is set. pinAsk = 'button' | 'toggle' | null.
  const [pinAsk, setPinAsk] = useState(null);
  const [pinInput, setPinInput] = useState('');
  const [pinErr, setPinErr] = useState('');
  useEffect(() => (pinAsk ? pushBackHandler(() => setPinAsk(null)) : undefined), [pinAsk]);
  const deactivateNow = () => {
    saveCustomer(fb, initial.id, { active: false });
    saveFeedback(true);
    onDone(null);
  };
  const askDeactivate = (kind) => {
    if (getPinHash()) {
      setPinInput('');
      setPinErr('');
      setPinAsk(kind);
      return;
    }
    // no PIN set on this phone: the old confirm
    if (kind === 'button') {
      if (window.confirm(t('confirmDeactivate'))) deactivateNow();
    } else {
      setF((p) => ({ ...p, active: false }));
    }
  };
  const submitPin = async () => {
    const w0 = pinWaitSeconds();
    if (w0 > 0) return setPinErr(t('pinWait').replace('{s}', w0));
    const ok = await verifyPin(pinInput.trim());
    if (!ok) {
      saveFeedback(false);
      const w = pinWaitSeconds();
      setPinErr(w > 0 ? t('pinWait').replace('{s}', w) : t('pinWrong'));
      return;
    }
    const kind = pinAsk;
    setPinAsk(null);
    if (kind === 'button') deactivateNow();
    else setF((p) => ({ ...p, active: false }));
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const submit = (e) => {
    e.preventDefault();
    const fail = (m) => {
      saveFeedback(false);
      setErr(m);
    };
    if (!f.name.trim()) return fail(t('nameRequired'));
    if (f.pauseFrom && f.pauseTo && f.pauseFrom > f.pauseTo) return fail(`${t('pauseFrom')} > ${t('pauseTo')}`);
    // A pause starts today or later (user, 16 Oct 2026). A pause already running keeps its old start.
    const today0 = todayISO();
    if (f.pauseFrom && f.pauseFrom < today0 && f.pauseFrom !== ((initial && initial.pauseFrom) || '')) return fail(t('pausePast'));
    if (f.pauseTo && f.pauseTo < today0 && f.pauseTo !== ((initial && initial.pauseTo) || '')) return fail(t('pausePast'));
    const badQty = (v) => v !== '' && v != null && (!Number.isFinite(Number(v)) || Number(v) < 0);
    if (badQty(f.usualMorningL) || badQty(f.usualEveningL)) return fail(t('qtyInvalid'));
    const rate = toPaise(f.rateOverride);
    if (f.customRate && !(rate > 0)) return fail(t('rateRequired'));
    const pRate = toPaise(f.paneerRateOverride);
    if (f.customPaneerRate && !(pRate > 0)) return fail(t('paneerRateRequired'));
    const due = toPaise(f.openingDue);
    if (f.openingDue !== '' && due === null) return fail(t('amountInvalid'));
    // Parse the money fields from the form passed in (not the current one): toData(f0.current)
    // used to get the NEW due / rates, so a changed due or rate never counted as a change.
    const toData = (f) => ({
      name: f.name.trim(),
      phone: f.phone.trim(),
      area: f.area.trim(),
      usualMorningL: round3(f.usualMorningL),
      usualEveningL: round3(f.usualEveningL),
      usualL: round3(round3(f.usualMorningL) + round3(f.usualEveningL)),
      rateOverridePaise: f.customRate ? toPaise(f.rateOverride) : null,
      paneerRateOverridePaise: f.customPaneerRate ? toPaise(f.paneerRateOverride) : null,
      openingDuePaise: Math.abs(toPaise(f.openingDue) || 0) * (f.openingAdv ? -1 : 1),
      pauseFrom: f.pauseFrom || '',
      pauseTo: f.pauseTo || '',
      active: !!f.active,
      isSupplier: !!f.isSupplier,
      prefillMode: f.prefillMode === 'lastDay' ? 'lastDay' : 'usual',
    });
    let data = toData(f);
    if (initial) {
      // Only what was changed in this form: another phone may have paused / deactivated / edited
      // this customer meanwhile, and re-sending the old values would undo that.
      data = entryChanges(toData(f0.current), data);
      if (!Object.keys(data).length) {
        saveFeedback(true);
        return onDone(initial.id);
      }
    }
    if (!initial) data.order = nextOrder;
    const savedId = saveCustomer(fb, initial ? initial.id : null, data);
    saveFeedback(true);
    onDone(savedId);
  };

  const stepUsual = (k, d) => setF({ ...f, [k]: Math.max(0, (Math.round(Number(f[k] || 0) * 1000) + d) / 1000) });

  return (
    // noValidate: the WebView's tiny validation bubbles were the only feedback; show our own errors.
    <form className="screen form" onSubmit={submit} noValidate data-noswipe>
      <header className="screen-head">
        <h1>{initial ? t('editCustomer') : t('addCustomer')}</h1>
      </header>
      <label>
        {t('name')} *
        <input value={f.name} onChange={set('name')} autoFocus={!initial} />
      </label>
      <label>
        {t('phone')}
        <input type="tel" inputMode="tel" value={f.phone} onChange={set('phone')} />
      </label>
      <label>
        {t('area')}
        <input value={f.area} onChange={set('area')} />
      </label>
      <label className="check">
        <input type="checkbox" checked={!!f.isSupplier} onChange={set('isSupplier')} /> 🏷️ {t('supplierHint')}
      </label>
      <div className="two">
        <label>
          {t('usualMorningL')}
          <div className="stepper">
            <button type="button" className="btn step" onClick={() => stepUsual('usualMorningL', -250)}>
              −
            </button>
            <input className="qty" type="number" inputMode="decimal" step="0.25" min="0" value={f.usualMorningL} onChange={set('usualMorningL')} />
            <button type="button" className="btn step" onClick={() => stepUsual('usualMorningL', 250)}>
              +
            </button>
          </div>
        </label>
        <label>
          {t('usualEveningL')}
          <div className="stepper">
            <button type="button" className="btn step" onClick={() => stepUsual('usualEveningL', -250)}>
              −
            </button>
            <input className="qty" type="number" inputMode="decimal" step="0.25" min="0" value={f.usualEveningL} onChange={set('usualEveningL')} />
            <button type="button" className="btn step" onClick={() => stepUsual('usualEveningL', 250)}>
              +
            </button>
          </div>
        </label>
      </div>
      <p className="muted small">{t('prefillHint')}</p>
      {[
        ['usual', 'prefillUsual'],
        ['lastDay', 'prefillLastDay'],
      ].map(([mode, key]) => (
        <div className="switch-row" key={mode}>
          <span>🔁 {t(key)}</span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            aria-label={t(key)}
            data-testid={'prefill-' + mode}
            checked={(f.prefillMode || 'usual') === mode}
            onChange={(e) => setF({ ...f, prefillMode: e.target.checked ? mode : mode === 'usual' ? 'lastDay' : 'usual' })}
          />
        </div>
      ))}
      <div className="switch-row">
        <span>🥛 {t('customRateToggle')}</span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label={t('customRateToggle')}
          checked={f.customRate}
          onChange={(e) => setF({ ...f, customRate: e.target.checked })}
        />
      </div>
      {f.customRate ? (
        <label>
          {t('customRateLabel')}
          <input type="number" inputMode="decimal" min="0" step="any" value={f.rateOverride} onChange={set('rateOverride')} />
        </label>
      ) : (
        <p className="muted small">{t('usesDefaultRate')}</p>
      )}
      <div className="switch-row">
        <span>🧀 {t('paneerRateToggle')}</span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label={t('paneerRateToggle')}
          checked={f.customPaneerRate}
          onChange={(e) => setF({ ...f, customPaneerRate: e.target.checked })}
        />
      </div>
      {f.customPaneerRate ? (
        <label>
          {t('paneerRateLabel')}
          <input type="number" inputMode="decimal" min="0" step="any" value={f.paneerRateOverride} onChange={set('paneerRateOverride')} />
        </label>
      ) : (
        <p className="muted small">{t('usesDefaultPaneerRate')}</p>
      )}
      <label>
        {t('openingDue')}
        <input type="number" inputMode="decimal" min="0" step="any" value={f.openingDue} onChange={set('openingDue')} />
      </label>
      <div className="seg-row" role="radiogroup">
        <button type="button" role="radio" aria-checked={!f.openingAdv} data-testid="opening-due" className={'btn small' + (!f.openingAdv ? ' primary' : '')} onClick={() => setF({ ...f, openingAdv: false })}>
          {t('openingIsDue')}
        </button>
        <button type="button" role="radio" aria-checked={!!f.openingAdv} data-testid="opening-adv" className={'btn small' + (f.openingAdv ? ' primary' : '')} onClick={() => setF({ ...f, openingAdv: true })}>
          {t('advance')}
        </button>
      </div>
      <div className="two">
        <label>
          {t('pauseFrom')}
          <input
            type="date"
            value={f.pauseFrom}
            min={initial && initial.pauseFrom && initial.pauseFrom < todayISO() ? initial.pauseFrom : todayISO()}
            onChange={set('pauseFrom')}
            data-testid="pause-from"
          />
        </label>
        <label>
          {t('pauseTo')}
          <input
            type="date"
            value={f.pauseTo}
            min={f.pauseFrom && f.pauseFrom > todayISO() ? f.pauseFrom : todayISO()}
            onChange={set('pauseTo')}
            data-testid="pause-to"
          />
        </label>
      </div>
      {/* Only the box itself toggles Active (a div, not a label: tapping the text does nothing). */}
      <div className="check box-only">
        <input
          type="checkbox"
          aria-label={t('active')}
          checked={f.active}
          onChange={(e) => {
            if (e.target.checked) setF((p) => ({ ...p, active: true }));
            else if (initial && initial.active !== false) askDeactivate('toggle');
            else setF((p) => ({ ...p, active: false }));
          }}
        />
        <span>{t('active')}</span>
      </div>
      {pinAsk && (
        <div className="card pin-card" data-testid="deactivate-pin">
          <p className="small">
            <b>🔒 {t('pinToDeactivate')}</b>
          </p>
          <div className="form-inline">
            <input
              type="password"
              inputMode="numeric"
              placeholder={t('pinEnter')}
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitPin();
                }
              }}
              maxLength={12}
              autoFocus
            />
            <button type="button" className="btn small danger" onClick={submitPin}>
              {t('deactivate')}
            </button>
            <button type="button" className="btn small ghost" onClick={() => setPinAsk(null)} aria-label={t('cancel')}>
              ✕
            </button>
          </div>
          {pinErr && <p className="error small">{pinErr}</p>}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <div className="form-actions">
        <button type="button" className="btn big" onClick={() => onDone(null)}>
          {t('cancel')}
        </button>
        <button type="submit" className="btn primary big">
          {t('save')}
        </button>
      </div>
      {initial && f.active && (
        <button
          type="button"
          className="btn danger"
          onClick={() => askDeactivate('button')}
        >
          {t('deactivate')}
        </button>
      )}
    </form>
  );
}
