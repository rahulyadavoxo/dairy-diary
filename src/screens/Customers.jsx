import { useMemo, useState } from 'react';
import { useLang } from '../i18n.js';
import { saveCustomer, saveOrder } from '../db.js';
import { sortCustomers } from './Register.jsx';
import { dmy, fmtQty, paiseToInput, rupees, toPaise } from '../format.js';
import ImportCustomers from './ImportCustomers.jsx';

const EMPTY = { name: '', phone: '', area: '', usualMorningL: 0.5, usualEveningL: 0.5, customRate: false, rateOverride: '', openingDue: '', pauseFrom: '', pauseTo: '', active: true, isSupplier: false };

const round3 = (n) => Math.max(0, Math.round(Number(n || 0) * 1000) / 1000);

/** Usual morning litres for a customer (falls back to half of legacy usualL). */
export function usualMorning(c) {
  if (Number.isFinite(Number(c.usualMorningL))) return round3(c.usualMorningL);
  return round3((Number(c.usualL) || 0) / 2);
}
/** Usual evening litres for a customer (falls back to half of legacy usualL). */
export function usualEvening(c) {
  if (Number.isFinite(Number(c.usualEveningL))) return round3(c.usualEveningL);
  return round3((Number(c.usualL) || 0) / 2);
}

export default function Customers({ fb, customers, settings, openCustomer }) {
  const { t } = useLang();
  const [editing, setEditing] = useState(null); // null | 'new' | customer
  const [importing, setImporting] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState({});
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
        onDone={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>
          {t('customersTitle')} <span className="muted small">({active.length})</span>
        </h1>
        <button className="btn primary big" onClick={() => setEditing('new')}>
          + {t('addCustomer')}
        </button>
        <button className="btn big" onClick={() => setImporting(true)}>
          ⇪ {t('importTitle')}
        </button>
        <button className="btn big" onClick={() => { setSelecting(!selecting); setSelected({}); }}>
          {selecting ? t('cancel') : t('selectTag')}
        </button>
        <p className="muted small">{t('routeOrder')}: ▲ / ▼</p>
      </header>
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
      <ul className="rows">
        {active.map((c, i) => (
          <li key={c.id} className="row cust-row">
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
                <button className="btn step" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('moveUp')}>
                  ▲
                </button>
                <button className="btn step" disabled={i === active.length - 1} onClick={() => move(i, 1)} aria-label={t('moveDown')}>
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
                {c.pauseFrom || c.pauseTo ? ` · ${t('paused')} ${dmy(c.pauseFrom)}–${dmy(c.pauseTo)}` : ''}
              </span>
            </button>
            <button className="btn small ghost" onClick={() => openCustomer(c.id)}>
              ₹
            </button>
          </li>
        ))}
      </ul>
      {inactive.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> {t('showInactive')} ({inactive.length})
        </label>
      )}
      {showInactive && (
        <ul className="rows">
          {inactive.map((c) => (
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

function CustomerForm({ fb, initial, nextOrder, onDone }) {
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
          openingDue: paiseToInput(initial.openingDuePaise || ''),
          pauseFrom: initial.pauseFrom || '',
          pauseTo: initial.pauseTo || '',
          active: initial.active !== false,
          isSupplier: !!initial.isSupplier,
        }
      : EMPTY,
  );
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const submit = (e) => {
    e.preventDefault();
    if (!f.name.trim()) return setErr(t('nameRequired'));
    const data = {
      name: f.name.trim(),
      phone: f.phone.trim(),
      area: f.area.trim(),
      usualMorningL: round3(f.usualMorningL),
      usualEveningL: round3(f.usualEveningL),
      usualL: round3(round3(f.usualMorningL) + round3(f.usualEveningL)),
      rateOverridePaise: f.customRate ? toPaise(f.rateOverride) || null : null,
      openingDuePaise: toPaise(f.openingDue) || 0,
      pauseFrom: f.pauseFrom || '',
      pauseTo: f.pauseTo || '',
      active: !!f.active,
      isSupplier: !!f.isSupplier,
    };
    if (!initial) data.order = nextOrder;
    saveCustomer(fb, initial ? initial.id : null, data);
    onDone();
  };

  const stepUsual = (k, d) => setF({ ...f, [k]: Math.max(0, (Math.round(Number(f[k] || 0) * 1000) + d) / 1000) });

  return (
    <form className="screen form" onSubmit={submit}>
      <header className="screen-head">
        <button type="button" className="btn small ghost" onClick={onDone}>
          ← {t('back')}
        </button>
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
      <label className="check">
        <input
          type="checkbox"
          checked={f.customRate}
          onChange={(e) => setF({ ...f, customRate: e.target.checked })}
        />{' '}
        {t('customRateToggle')}
      </label>
      {f.customRate ? (
        <label>
          {t('customRateLabel')}
          <input type="number" inputMode="decimal" min="0" step="0.5" value={f.rateOverride} onChange={set('rateOverride')} />
        </label>
      ) : (
        <p className="muted small">{t('usesDefaultRate')}</p>
      )}
      <label>
        {t('openingDue')}
        <input type="number" inputMode="decimal" step="1" value={f.openingDue} onChange={set('openingDue')} />
      </label>
      <div className="two">
        <label>
          {t('pauseFrom')}
          <input type="date" value={f.pauseFrom} onChange={set('pauseFrom')} />
        </label>
        <label>
          {t('pauseTo')}
          <input type="date" value={f.pauseTo} onChange={set('pauseTo')} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={f.active} onChange={set('active')} /> {t('active')}
      </label>
      {err && <p className="error">{err}</p>}
      <div className="form-actions">
        <button type="button" className="btn big" onClick={onDone}>
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
          onClick={() => {
            saveCustomer(fb, initial.id, { active: false });
            onDone();
          }}
        >
          {t('deactivate')}
        </button>
      )}
    </form>
  );
}
