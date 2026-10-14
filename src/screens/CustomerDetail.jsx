import { useMemo, useState } from 'react';
import { useLang } from '../i18n.js';
import { computeMonth, fullPaymentPaise } from '../billing.js';
import { addPayment, deletePayment } from '../db.js';
import { billText, waLink } from '../bill.js';
import { renderBillImage, shareImage, billFileName } from '../billImage.js';
import { dmy, firstWeekday, fmtQty, monthDates, paiseToInput, rupees, toPaise, todayISO } from '../format.js';
import { MonthNav } from './Hisaab.jsx';

const WEEK = { hi: ['र', 'सो', 'मं', 'बु', 'गु', 'शु', 'श'], en: ['S', 'M', 'T', 'W', 'T', 'F', 'S'] };

export default function CustomerDetail({ fb, customers, days, payments, settings, displayName, customerId, month, setMonth, onBack }) {
  const { t, lang } = useLang();
  const customer = customers.find((c) => c.id === customerId);
  const res = useMemo(
    () => (customer ? computeMonth({ customers: [customer], days, payments, settings, month }) : null),
    [customer, days, payments, settings, month],
  );
  const row = res && res.rows[0];
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('cash');
  const [payDate, setPayDate] = useState(todayISO());
  const [err, setErr] = useState('');

  if (!customer || !row) {
    return (
      <div className="screen">
        <button className="btn small ghost" onClick={onBack}>
          ← {t('back')}
        </button>
      </div>
    );
  }

  const record = (e) => {
    e.preventDefault();
    const p = toPaise(amount);
    if (!p || p <= 0) return setErr(t('amountInvalid'));
    setErr('');
    addPayment(fb, { customerId, date: payDate, amountPaise: p, mode, createdBy: displayName });
    setAmount('');
  };

  const [sharing, setSharing] = useState(false);
  const [shareErr, setShareErr] = useState('');
  const share = async () => {
    if (sharing) return;
    setSharing(true);
    setShareErr('');
    try {
      const blob = await renderBillImage(row, month, settings);
      await shareImage(blob, billFileName(customer.name, month));
    } catch (e) {
      console.error('[share-bill] photo failed, falling back to text', e);
      // Fallback: share as text via WhatsApp link
      try {
        const url = waLink(customer.phone, billText(row, month, settings));
        window.location.href = url;
      } catch (e2) {
        setShareErr(t('shareFailed'));
      }
    } finally {
      setSharing(false);
    }
  };

  const dates = monthDates(month);
  const blanks = Array.from({ length: firstWeekday(month) });
  const allPayments = payments
    .filter((p) => p.customerId === customerId)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));

  return (
    <div className="screen detail">
      <header className="screen-head">
        <button className="btn small ghost" onClick={onBack}>
          ← {t('back')}
        </button>
        <h1>{customer.name}</h1>
        <p className="muted small">{[customer.area, customer.phone].filter(Boolean).join(' · ')}</p>
        <MonthNav month={month} setMonth={setMonth} />
      </header>

      <div className="card summary">
        <div className="kv">
          <span>{t('totalLitres')}</span>
          <b>
            {fmtQty(row.milkMl / 1000)} {t('litre')} · {rupees(row.milkPaise)}
          </b>
        </div>
        {(row.paneerG > 0 || row.paneerPaise > 0) && (
          <div className="kv">
            <span>{t('paneer')}</span>
            <b>
              {fmtQty(row.paneerG / 1000)} {t('kg')} · {rupees(row.paneerPaise)}
            </b>
          </div>
        )}
        <div className="kv">
          <span>{t('previousDue')}</span>
          <b>{rupees(row.previousDuePaise)}</b>
        </div>
        <div className="kv">
          <span>{t('paidThisMonth')}</span>
          <b>{rupees(row.paidPaise)}</b>
        </div>
        <div className="kv big">
          <span>{row.balancePaise >= 0 ? t('balanceDue') : t('advance')}</span>
          <b className={row.balancePaise > 0 ? 'due' : 'clear'}>{rupees(Math.abs(row.balancePaise))}</b>
        </div>
        <button className="btn whatsapp big" onClick={share} disabled={sharing}>
          {sharing ? t('loading') : t('shareWhatsApp')}
        </button>
        {shareErr && <p className="err small">{shareErr}</p>}
        <p className="muted small">{t('waSharePhotoHint')}</p>
      </div>

      <h2>{t('calendar')}</h2>
      <div className="calendar">
        {WEEK[lang].map((w, i) => (
          <div key={'w' + i} className="cal-head">
            {w}
          </div>
        ))}
        {blanks.map((_, i) => (
          <div key={'b' + i} />
        ))}
        {dates.map((d) => {
          const e = row.daily[d];
          return (
            <div key={d} className={'cal-day' + (e ? (e.skip ? ' skip' : ' has') : '')}>
              <span className="cal-num">{Number(d.slice(8))}</span>
              <span className="cal-val">{e ? (e.skip && !e.paneerG ? '✕' : fmtQty(e.milkMl / 1000)) : ''}</span>
              {e && e.paneerG > 0 && <span className="cal-paneer">P {fmtQty(e.paneerG / 1000)}</span>}
            </div>
          );
        })}
      </div>

      <h2>{t('recordPayment')}</h2>
      <form className="card pay" onSubmit={record}>
        <div className="chips">
          <button type="button" className="btn chip" onClick={() => setAmount(paiseToInput(fullPaymentPaise(row.balancePaise)))}>
            {t('fullPayment')} {rupees(fullPaymentPaise(row.balancePaise))}
          </button>
          <button type="button" className="btn chip" onClick={() => setAmount('')}>
            {t('partPayment')}
          </button>
        </div>
        <label>
          {t('amount')}
          <input type="number" inputMode="decimal" min="0" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <div className="chips">
          <button type="button" className={'btn chip' + (mode === 'cash' ? ' on' : '')} onClick={() => setMode('cash')}>
            💵 {t('cash')}
          </button>
          <button type="button" className={'btn chip' + (mode === 'upi' ? ' on' : '')} onClick={() => setMode('upi')}>
            📱 {t('upi')}
          </button>
        </div>
        <p className="field-label">{t('date')}</p>
        <label className="date-pick">
          <span>{dmy(payDate)}</span>
          <input type="date" value={payDate} onChange={(e) => e.target.value && setPayDate(e.target.value)} />
        </label>
        {err && <p className="error">{err}</p>}
        <button className="btn primary big" type="submit">
          {t('addPayment')}
        </button>
      </form>

      <h2>{t('payments')}</h2>
      {allPayments.length === 0 && <p className="muted">{t('noPayments')}</p>}
      <ul className="rows">
        {allPayments.map((p) => (
          <li key={p.id} className={'row pay-row' + (p.date && p.date.startsWith(month) ? ' this-month' : '')}>
            <span>
              <b>{rupees(p.amountPaise)}</b> · {p.mode === 'upi' ? t('upi') : t('cash')}
              <br />
              <span className="muted small">
                {dmy(p.date)}
                {p.createdBy ? ` · ${p.createdBy}` : ''}
                {p._pending ? ` · ${t('pendingSync')}` : ''}
              </span>
            </span>
            <button
              className="btn small ghost"
              onClick={() => {
                if (window.confirm(t('confirmDelete'))) deletePayment(fb, p.id);
              }}
            >
              {t('deletePayment')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
