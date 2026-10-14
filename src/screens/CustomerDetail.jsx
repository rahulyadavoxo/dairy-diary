import { useEffect, useMemo, useState } from 'react';
import { firstDeliveryMonth } from '../firstMonth.js';
import { saveFeedback, playSound } from '../feedback.js';
import { useLang } from '../i18n.js';
import { computeMonth, fullPaymentPaise } from '../billing.js';
import { addPayment, deletePayment } from '../db.js';
import { renderBillImage, billFileName, billFingerprint } from '../billImage.js';
import { validWaNumber, sendBillToWhatsApp } from '../waShare.js';
import WaDirectHelp from '../components/WaDirectHelp.jsx';
import { getCachedPhoto, putCachedPhoto } from '../billCache.js';
import { dmy, fmtQty, mondayOffset, monthDates, paiseToInput, rupees, toPaise, todayISO, weekdaysMonFirst } from '../format.js';
import { MonthNav } from './Hisaab.jsx';
import { validUpiId, upiLink, qrDataUrl } from '../upi.js';

/** The user closed the share sheet: not an error, and not a reason to open WhatsApp anyway. */
export const isShareCancel = (e) => !!e && (e.name === 'AbortError' || /cancel/i.test(String(e.message || '')));

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
  // All hooks must run on every render, BEFORE any early return (Rules of Hooks).
  const [sharing, setSharing] = useState(false);
  const [shareErr, setShareErr] = useState('');
  const [noNumber, setNoNumber] = useState(false);
  // "Payment received" animation with the amount, after Add payment (closes by itself or on tap).
  const [paidAnim, setPaidAnim] = useState(null); // { paise, key }
  useEffect(() => {
    if (!paidAnim) return undefined;
    const id = setTimeout(() => setPaidAnim(null), 2600);
    return () => clearTimeout(id);
  }, [paidAnim]);

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
    if (!p || p <= 0) return saveFeedback(false), setErr(t('amountInvalid'));
    if (!payDate || payDate > todayISO()) return saveFeedback(false), setErr(t('dateFuture'));
    setErr('');
    addPayment(fb, { customerId, date: payDate, amountPaise: p, mode, createdBy: displayName });
    playSound('payment');
    setPaidAnim({ paise: p, key: Date.now() });
    setAmount('');
  };

  const share = async (pickManually = false) => {
    if (sharing) return;
    const n = validWaNumber(customer.phone);
    if (!n && !pickManually) { setNoNumber(true); setShareErr(''); return; }
    setNoNumber(false);
    setSharing(true);
    setShareErr('');
    try {
      const fp = billFingerprint(row, settings);
      let blob = await getCachedPhoto(customerId, month, fp);
      if (!blob) {
        blob = await renderBillImage(row, month, settings);
        putCachedPhoto(customerId, month, blob, fp);
      }
      await sendBillToWhatsApp({
        blob,
        fileName: billFileName(customer.name, month),
        phone: pickManually ? null : n,
      });
    } catch (e) {
      if (isShareCancel(e)) return;
      console.error('[share-bill] photo failed', e);
      setShareErr(e && e.code === 'NOT_INSTALLED' ? t('waNotInstalled') : t('shareFailed'));
    } finally {
      setSharing(false);
    }
  };

  // UPI QR at the very bottom of the page. Amount = what's typed in the payment box, else the
  // full amount due. Recomputed on every render, so it follows the amount live.
  const upiId = validUpiId(settings.upiId);
  const typedPaise = toPaise(amount);
  const qrAmount = typedPaise > 0 ? typedPaise : fullPaymentPaise(row.balancePaise);
  const qrLink = upiId && qrAmount > 0
    ? upiLink({ upiId, payeeName: settings.farmName || 'Dairy', amountPaise: qrAmount, note: `${settings.farmName || 'Dairy'} - ${customer.name}` })
    : null;
  const qrSrc = qrLink ? qrDataUrl(qrLink) : null; // plain compute: this runs after the early return, so no hooks here

  const dates = monthDates(month);
  const blanks = Array.from({ length: mondayOffset(month) }); // Monday-first, like the other calendars
  const allPayments = payments
    .filter((p) => p.customerId === customerId)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));

  return (
    <div className="screen detail">
      {paidAnim && (
        <div key={paidAnim.key} className="paid-overlay" role="status" data-testid="payment-received" onClick={() => setPaidAnim(null)}>
          <div className="paid-card">
            <svg className="paid-tick" viewBox="0 0 52 52" aria-hidden="true">
              <circle className="paid-tick-circle" cx="26" cy="26" r="24" fill="none" />
              <path className="paid-tick-check" fill="none" d="M14 27 l8 8 l16 -17" />
            </svg>
            <div className="paid-amount">{rupees(paidAnim.paise)}</div>
            <div className="paid-label">{t('paymentReceived')}</div>
            <div className="paid-coins" aria-hidden="true">
              <span>🪙</span>
              <span>💵</span>
              <span>🪙</span>
            </div>
          </div>
        </div>
      )}
      <header className="screen-head">
        <button className="btn small ghost" onClick={onBack}>
          ← {t('back')}
        </button>
        <h1>{customer.name}</h1>
        <p className="muted small">{[customer.area, customer.phone].filter(Boolean).join(' · ')}</p>
        <MonthNav month={month} setMonth={setMonth} minMonth={firstDeliveryMonth(days)} />
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
              {row.paneerG} {t('gram')} · {rupees(row.paneerPaise)}
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
          <span>{row.balancePaise >= 0 ? (customer.isSupplier ? t('weOwe') : t('balanceDue')) : t('advance')}</span>
          <b className={customer.isSupplier ? '' : row.balancePaise > 0 ? 'due' : 'clear'}>{rupees(Math.abs(row.balancePaise))}</b>
        </div>
        <button className="btn whatsapp big" onClick={() => share(false)} disabled={sharing}>
          {sharing ? t('loading') : t('shareWhatsApp')}
        </button>
        {shareErr && <p className="err small">{shareErr}</p>}
        {noNumber ? (
          <>
            <p className="err small" data-testid="wa-no-number">{t('waNoNumber')}</p>
            <button className="btn ghost" onClick={() => share(true)} disabled={sharing}>{t('waPickManually')}</button>
          </>
        ) : validWaNumber(customer.phone) ? (
          <WaDirectHelp phone={validWaNumber(customer.phone)} />
        ) : (
          <p className="muted small">{t('waNoNumber')}</p>
        )}
      </div>

      <h2>{t('calendar')}</h2>
      <div className="calendar">
        {weekdaysMonFirst(lang).map((w, i) => (
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
      <form className="card pay" onSubmit={record} noValidate>
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
          <input type="number" inputMode="decimal" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
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
          <span>{dmy(payDate, lang)}</span>
          <input type="date" value={payDate} max={todayISO()} onChange={(e) => e.target.value && setPayDate(e.target.value)} />
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
                {dmy(p.date, lang)}
                {p.createdBy ? ` · ${p.createdBy}` : ''}
                {p._pending ? ` · ${t('pendingSync')}` : ''}
              </span>
            </span>
            <button
              className="btn small ghost"
              onClick={() => {
                if (window.confirm(t('confirmDelete'))) {
                  deletePayment(fb, p.id, p);
                }
              }}
            >
              {t('deletePayment')}
            </button>
          </li>
        ))}
      </ul>

      <h2>{t('upiQrTitle')}</h2>
      <div className="card upi-qr" data-testid="upi-qr-box">
        {!upiId ? (
          <p className="muted small">{t('upiNotSet')}</p>
        ) : !qrSrc ? (
          <p className="muted small">{t('upiNoDue')}</p>
        ) : (
          <>
            <p className="small"><b>{t('upiScanToPay')}</b></p>
            <img src={qrSrc} alt="UPI QR" data-testid="upi-qr" style={{ width: '100%', maxWidth: 280, imageRendering: 'pixelated', background: '#fff', borderRadius: 12 }} />
            <p className="kv big"><span>{t('upiPayable')}</span><b data-testid="upi-qr-amount">{rupees(qrAmount)}</b></p>
            <p className="muted small">{upiId}</p>
            <p className="muted small">{t('upiAfterPaid')}</p>
          </>
        )}
      </div>
    </div>
  );
}
