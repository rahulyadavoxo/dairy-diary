// Money fixes (code review 4 Nov 2026): #3 suppliers on a past month, #4 past-month CSV
// "Paid later" / "Left today", #5 firstDeliveryMonth counts paneer on absent days and the
// morning / evening milk split.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../src/billPreGen.js', () => ({ preGenerateBillPhotos: vi.fn() }));
vi.mock('../src/billImage.js', async (orig) => ({ ...(await orig()), renderBillImage: vi.fn(), shareImage: vi.fn() }));

import Hisaab, { resetHisaabView } from '../src/screens/Hisaab.jsx';
import { LangContext, makeT } from '../src/i18n.js';
import { monthCsv } from '../src/exportExcel.js';
import { firstDeliveryMonth, defaultCustomerMonth } from '../src/firstMonth.js';
import { computeMonth, withLaterPayments, leftOf } from '../src/billing.js';

const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;

beforeEach(() => {
  resetHisaabView();
  cleanup();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 4, 10, 0)); // 4 Nov 2026, local
});
afterEach(() => vi.useRealTimers());

describe('#3 suppliers on a past month keep closing balance (order matches the numbers)', () => {
  const customers = [
    { id: 'sa', name: 'Supplier A', isSupplier: true },
    { id: 'sb', name: 'Supplier B', isSupplier: true },
    { id: 'c', name: 'Cust C' },
  ];
  // Oct: A sells 100 L, B 20 L, at ₹50 → A ₹5,000, B ₹1,000. A is paid ₹5,000 on 2 Nov.
  const days = { '2026-10-05': { entries: { sa: { milkL: 100 }, sb: { milkL: 20 }, c: { milkL: 1 } } } };
  const payments = [{ id: 'p1', customerId: 'sa', amountPaise: 500000, date: '2026-11-02', mode: 'cash' }];

  it('A (₹5,000) is listed before B (₹1,000) on the October view', () => {
    render(wrap(<Hisaab fb={{}} customers={customers} days={days} payments={payments} settings={{ milkRatePaise: 5000 }} month="2026-10" setMonth={() => {}} openCustomer={() => {}} />));
    const items = screen.getAllByText(/Supplier [AB]/).map((el) => el.closest('li'));
    const names = items.map((li) => (li.textContent.includes('Supplier A') ? 'A' : 'B'));
    expect(names).toEqual(['A', 'B']);
    expect(items[0].textContent).toMatch(/5,000/);
    expect(items[1].textContent).toMatch(/1,000/);
  });
});

describe('#4 past-month CSV has "Paid later" and "Left today"', () => {
  const customers = [
    { id: 'a', name: 'Aadil', openingDuePaise: 0 },
    { id: 'b', name: 'Bina' },
    { id: 's', name: 'Supp', isSupplier: true },
  ];
  // Oct: Aadil 10 L x ₹60 = ₹600, Bina 5 L = ₹300, both unpaid in Oct.
  // Aadil pays ₹200 on 2 Nov, Bina pays ₹500 on 3 Nov (more than her ₹300).
  const days = { '2026-10-03': { entries: { a: { milkL: 10 }, b: { milkL: 5 }, s: { milkL: 4 } } } };
  const payments = [
    { id: 'p1', customerId: 'a', amountPaise: 20000, date: '2026-11-02', mode: 'cash' },
    { id: 'p2', customerId: 'b', amountPaise: 50000, date: '2026-11-03', mode: 'upi' },
    { id: 'p3', customerId: 's', amountPaise: 10000, date: '2026-11-03', mode: 'cash' },
  ];
  const settings = { milkRatePaise: 6000 };
  const parse = (csv) => csv.split('\r\n').map((l) => l.split(','));

  it('adds the columns for customers, Balance stays closing, Left total = Hisaab Pending', () => {
    const rows = parse(monthCsv({ customers, days, payments, settings, month: '2026-10', lang: 'en' }));
    const head = rows.find((r) => r[1] === 'Name');
    expect(head.slice(-3)).toEqual(['Balance ₹', 'Paid later ₹', 'Left today ₹']);
    const aadil = rows.find((r) => r[1] === 'Aadil');
    expect(aadil.slice(-3)).toEqual(['600.00', '200.00', '400.00']);
    const bina = rows.find((r) => r[1] === 'Bina');
    expect(bina.slice(-3)).toEqual(['300.00', '500.00', '0.00']);
    const total = rows.find((r) => r[1] === 'Total' && r.length === head.length);
    expect(total.slice(-3)).toEqual(['900.00', '700.00', '400.00']);

    // Same number Hisaab uses for Pending on a past month
    const res = computeMonth({ customers, days, payments, settings, month: '2026-10' });
    const pending = res.rows
      .filter((r) => !r.customer.isSupplier)
      .map((r) => withLaterPayments(r, payments, '2026-10', '2026-11-04'))
      .reduce((s, r) => s + Math.max(0, leftOf(r)), 0);
    expect(pending).toBe(40000);

    // Supplier block keeps the old columns
    const supHeadIdx = rows.findIndex((r) => r[0] && r[0].startsWith('Suppliers'));
    expect(rows[supHeadIdx + 1].slice(-1)).toEqual(['Balance ₹']);
  });

  it('current month has no extra columns', () => {
    const csv = monthCsv({ customers, days: { '2026-11-01': { entries: { a: { milkL: 1 } } } }, payments, settings, month: '2026-11', lang: 'en' });
    expect(csv).not.toContain('Paid later');
    expect(csv).not.toContain('Left today');
  });

  it('Hindi labels exist', () => {
    const csv = monthCsv({ customers, days, payments, settings, month: '2026-10', lang: 'hi' });
    expect(csv).toContain('बाद में मिला ₹');
    expect(csv).toContain('आज तक बाकी ₹');
  });
});

describe('#5 firstDeliveryMonth', () => {
  it('counts paneer on an absent (skip) day', () => {
    const days = {
      '2026-09-30': { entries: { a: { skip: true, paneerKg: 0.5 } } },
      '2026-10-01': { entries: { a: { milkL: 1 } } },
    };
    expect(firstDeliveryMonth(days)).toBe('2026-09');
  });
  it('counts morning / evening milk without milkL', () => {
    expect(firstDeliveryMonth({ '2026-08-10': { entries: { a: { milkMorningL: 1 } } }, '2026-10-01': { entries: { a: { milkL: 1 } } } })).toBe('2026-08');
    expect(firstDeliveryMonth({ '2026-07-10': { entries: { a: { milkEveningL: 0.5 } } } })).toBe('2026-07');
  });
  it('a skip day with only milk does not count; empty days do not count', () => {
    expect(firstDeliveryMonth({ '2026-08-10': { entries: { a: { skip: true, milkL: 2 } } }, '2026-10-01': { entries: { a: { milkL: 1 } } } })).toBe('2026-10');
    expect(firstDeliveryMonth({ '2026-08-10': { entries: { a: { milkL: 0 } } } })).toBe('2026-11');
  });
  it('defaultCustomerMonth uses a paneer-only absent day in the previous month', () => {
    expect(defaultCustomerMonth({ '2026-10-20': { entries: { a: { skip: true, paneerKg: 0.25 } } } })).toBe('2026-10');
  });
});
