import { useMemo, useState } from 'react';
import { useLang } from '../i18n.js';
import { computeMonth, sortByDue } from '../billing.js';
import { addMonths, fmtQty, monthDates, monthName, rupees, todayISO, monthOf } from '../format.js';
import BillSender, { shouldPromptBills } from './BillSender.jsx';
import BillPhotos from './BillPhotos.jsx';

export function MonthNav({ month, setMonth }) {
  const { t, lang } = useLang();
  const curMonth = monthOf(todayISO());
  const goMonth = (m) => setMonth(m > curMonth ? curMonth : m);
  return (
    <div className="date-nav">
      <button className="btn icon" onClick={() => goMonth(addMonths(month, -1))} aria-label={t('prevMonth')}>
        ◀
      </button>
      <label className="date-pick">
        <span>{monthName(month, lang)}</span>
        <input type="month" value={month} max={curMonth} onChange={(e) => e.target.value && goMonth(e.target.value)} />
      </label>
      <button
        className="btn icon"
        disabled={month === curMonth}
        onClick={() => {
          const n = addMonths(month, 1);
          if (n <= curMonth) setMonth(n);
        }}
        aria-label={t('nextMonth')}
      >
        ▶
      </button>
    </div>
  );
}

export default function Hisaab({ fb, customers, days, payments, settings, month, setMonth, openCustomer }) {
  const { t } = useLang();
  const [sending, setSending] = useState(false);
  const [photos, setPhotos] = useState(false);
  const [showTotals, setShowTotals] = useState(() => {
    try {
      return localStorage.getItem('dd_show_totals') !== '0';
    } catch {
      return true;
    }
  });
  const toggleTotals = () => {
    setShowTotals((v) => {
      const nv = !v;
      try {
        localStorage.setItem('dd_show_totals', nv ? '1' : '0');
      } catch {}
      return nv;
    });
  };
  const res = useMemo(() => computeMonth({ customers, days, payments, settings, month }), [customers, days, payments, settings, month]);
  const allRows = res.rows.filter((r) => r.customer.active !== false || r.hasActivity || r.balancePaise !== 0);
  const rows = sortByDue(allRows);
  const sTotals = res.supplierTotals || { billedPaise: 0, collectedPaise: 0, pendingPaise: 0, advancePaise: 0 };
  const hasSuppliers = allRows.some((r) => r.customer.isSupplier);
  const md = monthDates(monthOf(todayISO()));
  const isLastDay = todayISO() === md[md.length - 1];

  if (sending) {
    return <BillSender fb={fb} customers={customers} days={days} payments={payments} settings={settings} onClose={() => setSending(false)} />;
  }
  if (photos) {
    return <BillPhotos customers={customers} days={days} payments={payments} settings={settings} month={month} onClose={() => setPhotos(false)} />;
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>{t('hisaabTitle')}</h1>
        <MonthNav month={month} setMonth={setMonth} />
        {shouldPromptBills(settings) && (
          <div className="card warn">
            <p><b>{t('waBillsTitle')}</b></p>
            <p className="small">{t('waBillsIntro')}</p>
            <button type="button" className="btn whatsapp big" onClick={() => setSending(true)}>
              {t('sendBills')}
            </button>
          </div>
        )}
        <div className="chips">
          <button type="button" className="btn chip" onClick={() => setSending(true)}>
            📲 {t('waBillsTitle')}
          </button>
          <button type="button" className={'btn chip' + (isLastDay ? ' on' : '')} onClick={() => setPhotos(true)}>
            🖼️ {t('billPhotos')}
          </button>
        </div>
        <div className="totals-head">
          <button type="button" className="btn small ghost" onClick={toggleTotals}>
            {showTotals ? '👁️' : '👁️‍🗨️'} {showTotals ? t('hide') : t('show')}
          </button>
        </div>
        {showTotals && (
          <div className="totals">
            <div className="total">
              <span>{t('billed')}</span>
              <b>{rupees(res.totals.billedPaise)}</b>
            </div>
            <div className="total good">
              <span>{t('collected')}</span>
              <b>{rupees(res.totals.collectedPaise)}</b>
            </div>
            <div className="total bad">
              <span>{t('pending')}</span>
              <b>{rupees(res.totals.pendingPaise)}</b>
            </div>
          </div>
        )}
        {res.totals.advancePaise > 0 && (
          <p className="muted small">
            {t('advance')}: {rupees(res.totals.advancePaise)}
          </p>
        )}
        <p className="muted small">{t('sortedByDue')}</p>
      </header>
      {rows.length === 0 && <p className="empty">{t('noActivity')}</p>}
      {hasSuppliers && showTotals && (
        <div className="card" style={{ marginBottom: '0.8rem' }}>
          <h3 style={{ margin: '0 0 0.5rem 0' }}>🏷️ {t('supplierHisaab')}</h3>
          <p className="muted small" style={{ margin: '0 0 0.6rem 0' }}>{t('supplierHisaabHint')}</p>
          <div className="totals">
            <div className="total">
              <span>{t('purchased')}</span>
              <b>{rupees(sTotals.billedPaise)}</b>
            </div>
            <div className="total good">
              <span>{t('paidToSupplier')}</span>
              <b>{rupees(sTotals.collectedPaise)}</b>
            </div>
            <div className="total bad">
              <span>{t('weOwe')}</span>
              <b>{rupees(sTotals.pendingPaise)}</b>
            </div>
          </div>
        </div>
      )}
      <ul className="rows">
        {rows.map((r) => (
          <li key={r.customerId}>
            <button className="row hisaab-row" onClick={() => openCustomer(r.customerId)}>
              <div className="row-top">
                <b>
                  {r.customer.name}
                  {r.customer.isSupplier && <span className="tag supplier-tag"> 🏷️ {t('supplier')}</span>}
                </b>
                <b className={r.balancePaise > 0 ? 'due' : 'clear'}>{rupees(r.balancePaise)}</b>
              </div>
              <div className="grid-4 small">
                <span>
                  {t('totalLitres')}
                  <br />
                  <b>
                    {fmtQty(r.milkMl / 1000)} {t('litre')}
                  </b>
                </span>
                <span>
                  {t('milkAmount')}
                  <br />
                  <b>{rupees(r.milkPaise)}</b>
                </span>
                <span>
                  {t('paneer')}
                  <br />
                  <b>
                    {fmtQty(r.paneerG / 1000)} {t('kg')} · {rupees(r.paneerPaise)}
                  </b>
                </span>
                <span>
                  {t('previousDue')}
                  <br />
                  <b>{rupees(r.previousDuePaise)}</b>
                </span>
                <span>
                  {t('paidThisMonth')}
                  <br />
                  <b>{rupees(r.paidPaise)}</b>
                </span>
                <span>
                  {t('balanceDue')}
                  <br />
                  <b>{rupees(r.balancePaise)}</b>
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
