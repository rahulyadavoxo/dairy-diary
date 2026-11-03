// 1.10.69: Delete payment asks the Hisaab PIN (falls back to confirm when no PIN is set).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
vi.mock('../src/db.js', async (orig) => ({ ...(await orig()), deletePayment: vi.fn() }));
import { deletePayment } from '../src/db.js';
import { LangContext, makeT } from '../src/i18n.js';
import { todayISO } from '../src/format.js';
import { hashPin, savePinHash } from '../src/pinLock.js';
import CustomerDetail from '../src/screens/CustomerDetail.jsx';

const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
const m = todayISO().slice(0, 7);
const base = {
  fb: { farmId: 'F', fsMod: {} },
  customers: [{ id: 'a', name: 'Asha' }],
  days: {},
  payments: [{ id: 'p1', customerId: 'a', amountPaise: 50000, date: m + '-01', mode: 'cash' }],
  settings: {},
  month: m,
  setMonth: () => {},
};

describe('delete payment PIN', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
    deletePayment.mockClear();
  });
  it('no PIN set: confirm decides', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(wrap(<CustomerDetail {...base} customerId="a" onBack={() => {}} />));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deletePayment).not.toHaveBeenCalled();
  });
  it('PIN set: wrong PIN keeps the payment', async () => {
    savePinHash(await hashPin('4321'));
    render(wrap(<CustomerDetail {...base} customerId="a" onBack={() => {}} />));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const input = screen.getByPlaceholderText('Enter PIN');
    fireEvent.change(input, { target: { value: '1111' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await screen.findByText(/Wrong PIN|wait/i);
    expect(deletePayment).not.toHaveBeenCalled();
  });
});

import { isPaidRow, withLaterPayments, computeMonth } from '../src/billing.js';
describe('past month counts later payments', () => {
  const cust = [{ id: 'a', name: 'A' }];
  const days = { '2026-10-05': { entries: { a: { milkL: 10, milkRatePaise: 6000 } } } }; // ₹600
  it('paid in Nov -> October shows paid', () => {
    const pays = [{ customerId: 'a', date: '2026-11-03', amountPaise: 60000 }];
    const r = computeMonth({ customers: cust, days, payments: pays, settings: {}, month: '2026-10' }).rows[0];
    expect(isPaidRow(r)).toBe(false);
    const w = withLaterPayments(r, pays, '2026-10', '2026-11-03');
    expect(w.leftPaise).toBe(0);
    expect(isPaidRow(w)).toBe(true);
  });
  it('partly paid later stays unpaid with the rest', () => {
    const pays = [{ customerId: 'a', date: '2026-11-03', amountPaise: 20000 }];
    const r = computeMonth({ customers: cust, days, payments: pays, settings: {}, month: '2026-10' }).rows[0];
    const w = withLaterPayments(r, pays, '2026-10', '2026-11-03');
    expect(w.leftPaise).toBe(40000);
    expect(isPaidRow(w)).toBe(false);
  });
  it('bill fully covered by earlier advance is paid', () => {
    const pays = [{ customerId: 'a', date: '2026-09-20', amountPaise: 60000 }];
    const r = computeMonth({ customers: cust, days, payments: pays, settings: {}, month: '2026-10' }).rows[0];
    expect(r.balancePaise).toBe(0);
    expect(isPaidRow(r)).toBe(true);
  });
  it('zero bill and no payment stays unpaid', () => {
    const r = computeMonth({ customers: cust, days: {}, payments: [], settings: {}, month: '2026-10' }).rows[0];
    expect(isPaidRow(r)).toBe(false);
  });
});

import { templateParams } from '../src/autoBill.js';
describe('bills count later payments', () => {
  it('auto-bill balance uses what is left today', () => {
    const cust = [{ id: 'a', name: 'A', phone: '9999999999' }];
    const days = { '2026-10-05': { entries: { a: { milkL: 10, milkRatePaise: 6000 } } } };
    const pays = [{ customerId: 'a', date: '2026-11-02', amountPaise: 60000 }];
    const r = computeMonth({ customers: cust, days, payments: pays, settings: {}, month: '2026-10' }).rows[0];
    const w = withLaterPayments(r, pays, '2026-10', '2026-11-05');
    expect(templateParams(w, '2026-10', {})[3]).not.toContain('600');
  });
});
