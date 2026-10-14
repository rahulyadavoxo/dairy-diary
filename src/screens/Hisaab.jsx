import { useEffect, useMemo, useState } from 'react';
import { pushBackHandler } from '../backStack.js';
import { useLang } from '../i18n.js';
import { computeMonth, sortByDue } from '../billing.js';
import { getPinHash, verifyPin, pinWaitSeconds } from '../pinLock.js';
import { preGenerateBillPhotos } from '../billPreGen.js';
import { fmtQty, monthDates, rupees, todayISO, monthOf } from '../format.js';
import BillSender, { shouldPromptBills } from './BillSender.jsx';
import BillPhotos, { defaultPhotoMonth } from './BillPhotos.jsx';
import MonthNav from '../components/MonthNav.jsx';

export { MonthNav };

export default function Hisaab({ fb, customers, days, payments, settings, month, setMonth, openCustomer }) {
  const { t } = useLang();
  const [sending, setSending] = useState(false);
  const [photos, setPhotos] = useState(false);
  const [showTotals, setShowTotals] = useState(() => {
    // With a PIN set, totals must be hidden on the very first paint. The effect below runs
    // after paint, so starting from the saved '1' flashed the totals for a moment.
    if (getPinHash()) return false;
    try {
      return localStorage.getItem('dd_show_totals') !== '0';
    } catch {
      return true;
    }
  });
  const [pinOpen, setPinOpen] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinErr, setPinErr] = useState('');
  // Check lock fresh from storage on every render (Settings may have changed it)
  const pinLocked = !!getPinHash();
  // With a PIN, "hidden" hides every amount on this screen, not only the three total tiles.
  const masked = pinLocked && !showTotals;
  const money = (p) => (masked ? '₹ ••••' : rupees(p));

  // Hardware back closes the bill sender / bill photos instead of jumping to the Register tab.
  useEffect(() => (sending ? pushBackHandler(() => setSending(false)) : undefined), [sending]);
  useEffect(() => (photos ? pushBackHandler(() => setPhotos(false)) : undefined), [photos]);

  const doHideShow = (v) => {
    setShowTotals(v);
    try {
      localStorage.setItem('dd_show_totals', v ? '1' : '0');
    } catch {}
  };

  // Lock enforcement: whenever this screen mounts/shows with a PIN set, totals start hidden.
  // Also re-runs when the lock appears while the screen is open (old synced PIN copied to this
  // phone after settings load), which the mount-only [] version missed.
  useEffect(() => {
    if (pinLocked) {
      doHideShow(false);
      setPinOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinLocked]);

  const toggleTotals = () => {
    if (showTotals) {
      // Hiding never needs PIN
      doHideShow(false);
    } else if (getPinHash()) {
      // Showing needs PIN
      setPinInput('');
      setPinErr('');
      setPinOpen(true);
    } else {
      doHideShow(true);
    }
  };

  const submitPin = async (e) => {
    e.preventDefault();
    const ok = await verifyPin(pinInput.trim());
    if (ok) {
      setPinOpen(false);
      doHideShow(true);
    } else {
      const w = pinWaitSeconds();
      setPinErr(w > 0 ? t('pinWait').replace('{s}', w) : t('pinWrong'));
    }
  };
  const res = useMemo(() => computeMonth({ customers, days, payments, settings, month }), [customers, days, payments, settings, month]);
  const allRows = res.rows.filter((r) => r.customer.active !== false || r.hasActivity || r.balancePaise !== 0);

  // Pre-generate bill photos in the background so sharing is instant later.
  // Re-run when the data arrives / changes (it was [month] only, so on app start it ran with an
  // empty list and never again). Cached photos are fingerprinted, so unchanged bills are skipped.
  useEffect(() => {
    preGenerateBillPhotos(allRows.filter((r) => !r.customer.isSupplier), month, settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, res]);
  // Customers (they owe us) and suppliers (we owe them) are listed separately.
  const rows = sortByDue(allRows.filter((r) => !r.customer.isSupplier));
  const supplierRows = sortByDue(allRows.filter((r) => r.customer.isSupplier));
  const sTotals = res.supplierTotals || { billedPaise: 0, collectedPaise: 0, pendingPaise: 0, advancePaise: 0 };
  const hasSuppliers = supplierRows.length > 0;
  const md = monthDates(monthOf(todayISO()));
  const isLastDay = todayISO() === md[md.length - 1];

  if (sending) {
    return <BillSender fb={fb} customers={customers} days={days} payments={payments} settings={settings} onClose={() => setSending(false)} />;
  }
  if (photos) {
    return <BillPhotos customers={customers} days={days} payments={payments} settings={settings} month={defaultPhotoMonth(month)} onClose={() => setPhotos(false)} />;
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
            {showTotals ? '👁️' : pinLocked ? '🔒' : '👁️‍🗨️'} {showTotals ? t('hide') : t('show')}
          </button>
        </div>
        {pinOpen && (
          <div className="card" style={{ marginBottom: '0.6rem' }}>
            <form onSubmit={submitPin} className="form-inline">
              <input
                type="password"
                inputMode="numeric"
                placeholder={t('pinEnter')}
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                maxLength={12}
                autoFocus
              />
              <button type="submit" className="btn small primary">
                {t('pinUnlock')}
              </button>
              <button type="button" className="btn small ghost" onClick={() => setPinOpen(false)}>
                ✕
              </button>
            </form>
            {pinErr && <p className="error small">{pinErr}</p>}
          </div>
        )}
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
        {showTotals && res.totals.advancePaise > 0 && (
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
                <b className={masked ? 'muted' : r.balancePaise > 0 ? 'due' : 'clear'}>{money(r.balancePaise)}</b>
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
                  <b>{money(r.milkPaise)}</b>
                </span>
                <span>
                  {t('paneer')}
                  <br />
                  <b>
                    {fmtQty(r.paneerG / 1000)} {t('kg')} · {money(r.paneerPaise)}
                  </b>
                </span>
                <span>
                  {t('previousDue')}
                  <br />
                  <b>{money(r.previousDuePaise)}</b>
                </span>
                <span>
                  {t('paidThisMonth')}
                  <br />
                  <b>{money(r.paidPaise)}</b>
                </span>
                <span>
                  {t('balanceDue')}
                  <br />
                  <b>{money(r.balancePaise)}</b>
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {hasSuppliers && (
        <h2>🏷️ {t('supplierHisaab')}</h2>
      )}
      {hasSuppliers && showTotals && (
        <div className="card" style={{ marginBottom: '0.8rem' }}>
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
      {hasSuppliers && (
        <ul className="rows" data-testid="supplier-rows">
          {supplierRows.map((r) => (
            <li key={r.customerId}>
              <button className="row hisaab-row" onClick={() => openCustomer(r.customerId)}>
                <div className="row-top">
                  <b>
                    {r.customer.name}
                    <span className="tag supplier-tag"> 🏷️ {t('supplier')}</span>
                  </b>
                  <b>{money(Math.abs(r.balancePaise))}</b>
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
                    {t('purchased')}
                    <br />
                    <b>{money(r.billedPaise)}</b>
                  </span>
                  <span>
                    {t('paidToSupplier')}
                    <br />
                    <b>{money(r.paidPaise)}</b>
                  </span>
                  <span>
                    {r.balancePaise >= 0 ? t('weOwe') : t('advance')}
                    <br />
                    <b>{money(Math.abs(r.balancePaise))}</b>
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
