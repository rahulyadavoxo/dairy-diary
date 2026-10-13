import { useMemo } from 'react';
import { useLang } from '../i18n.js';
import { computeMonth, sortByDue } from '../billing.js';
import { addMonths, fmtQty, monthName, rupees } from '../format.js';

export function MonthNav({ month, setMonth }) {
  const { t, lang } = useLang();
  return (
    <div className="date-nav">
      <button className="btn icon" onClick={() => setMonth(addMonths(month, -1))} aria-label={t('prevMonth')}>
        ◀
      </button>
      <label className="date-pick">
        <span>{monthName(month, lang)}</span>
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
      </label>
      <button className="btn icon" onClick={() => setMonth(addMonths(month, 1))} aria-label={t('nextMonth')}>
        ▶
      </button>
    </div>
  );
}

export default function Hisaab({ customers, days, payments, settings, month, setMonth, openCustomer }) {
  const { t } = useLang();
  const res = useMemo(() => computeMonth({ customers, days, payments, settings, month }), [customers, days, payments, settings, month]);
  const rows = sortByDue(res.rows.filter((r) => r.customer.active !== false || r.hasActivity || r.balancePaise !== 0));

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>{t('hisaabTitle')}</h1>
        <MonthNav month={month} setMonth={setMonth} />
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
        {res.totals.advancePaise > 0 && (
          <p className="muted small">
            {t('advance')}: {rupees(res.totals.advancePaise)}
          </p>
        )}
        <p className="muted small">{t('sortedByDue')}</p>
      </header>
      {rows.length === 0 && <p className="empty">{t('noActivity')}</p>}
      <ul className="rows">
        {rows.map((r) => (
          <li key={r.customerId}>
            <button className="row hisaab-row" onClick={() => openCustomer(r.customerId)}>
              <div className="row-top">
                <b>{r.customer.name}</b>
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
