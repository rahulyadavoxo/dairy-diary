import { useMemo, useState } from 'react';
import { useLang } from '../i18n.js';
import { saveCustomer, saveOrder } from '../db.js';
import { sortCustomers } from './Register.jsx';
import { dmy, fmtQty, paiseToInput, rupees, toPaise } from '../format.js';

const EMPTY = { name: '', phone: '', area: '', usualL: 1, rateOverride: '', openingDue: '', pauseFrom: '', pauseTo: '', active: true };

export default function Customers({ fb, customers, settings, openCustomer }) {
  const { t } = useLang();
  const [editing, setEditing] = useState(null); // null | 'new' | customer
  const [showInactive, setShowInactive] = useState(false);
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
        <p className="muted small">{t('routeOrder')}: ▲ / ▼</p>
      </header>
      {active.length === 0 && <p className="empty">{t('noCustomers')}</p>}
      <ul className="rows">
        {active.map((c, i) => (
          <li key={c.id} className="row cust-row">
            <div className="order-btns">
              <button className="btn step" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('moveUp')}>
                ▲
              </button>
              <button className="btn step" disabled={i === active.length - 1} onClick={() => move(i, 1)} aria-label={t('moveDown')}>
                ▼
              </button>
            </div>
            <button className="cust-main" onClick={() => setEditing(c)}>
              <b>
                {i + 1}. {c.name}
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
          rateOverride: paiseToInput(initial.rateOverridePaise),
          openingDue: paiseToInput(initial.openingDuePaise || ''),
          pauseFrom: initial.pauseFrom || '',
          pauseTo: initial.pauseTo || '',
          active: initial.active !== false,
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
      usualL: Math.max(0, Math.round(Number(f.usualL || 0) * 1000) / 1000),
      rateOverridePaise: toPaise(f.rateOverride) || null,
      openingDuePaise: toPaise(f.openingDue) || 0,
      pauseFrom: f.pauseFrom || '',
      pauseTo: f.pauseTo || '',
      active: !!f.active,
    };
    if (!initial) data.order = nextOrder;
    saveCustomer(fb, initial ? initial.id : null, data);
    onDone();
  };

  const stepL = (d) => setF({ ...f, usualL: Math.max(0, (Math.round(Number(f.usualL || 0) * 1000) + d) / 1000) });

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
      <label>
        {t('usualLitres')}
        <div className="stepper">
          <button type="button" className="btn step" onClick={() => stepL(-500)}>
            −
          </button>
          <input className="qty" type="number" inputMode="decimal" step="0.5" min="0" value={f.usualL} onChange={set('usualL')} />
          <button type="button" className="btn step" onClick={() => stepL(500)}>
            +
          </button>
        </div>
      </label>
      <label>
        {t('rateOverride')}
        <input type="number" inputMode="decimal" min="0" step="0.5" value={f.rateOverride} onChange={set('rateOverride')} />
      </label>
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
