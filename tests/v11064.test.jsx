// v1.10.64: Hisaab card header shows only this month's amount; Balance due keeps old dues.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../src/billPreGen.js', () => ({ preGenerateBillPhotos: vi.fn() }));
vi.mock('../src/billImage.js', async (orig) => ({ ...(await orig()), renderBillImage: vi.fn(), shareImage: vi.fn() }));

import Hisaab, { resetHisaabView } from '../src/screens/Hisaab.jsx';
import { LangContext, makeT } from '../src/i18n.js';

const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
const customers = [
  { id: 'a', name: 'Aadil G', openingDuePaise: 100000 },
  { id: 'b', name: 'Mini singh', openingDuePaise: 50000 },
];
// a: Oct bill 2 L x ₹60 = ₹120, no payment. b: Oct bill ₹60, paid ₹100 (bill cleared, old due remains).
const days = { '2026-10-01': { entries: { a: { milkL: 2 }, b: { milkL: 1 } } } };
const payments = [{ id: 'p1', customerId: 'b', amountPaise: 10000, date: '2026-10-02', mode: 'cash' }];

beforeEach(() => { resetHisaabView(); cleanup(); localStorage.clear(); });

describe('Hisaab header = this month only', () => {
  it('red header shows month bill minus month payment; Balance due shows the full total', () => {
    render(wrap(<Hisaab fb={{}} customers={customers} days={days} payments={payments} settings={{ milkRatePaise: 6000 }} month="2026-10" setMonth={() => {}} openCustomer={() => {}} />));
    const heads = screen.getAllByTestId('row-balance');
    const byName = (n) => heads.find((h) => h.closest('li').textContent.includes(n));
    const a = byName('Aadil G');
    expect(a.textContent).toMatch(/120/);
    expect(a.textContent).not.toMatch(/1,120/);
    expect(a.className).toBe('due');
    expect(a.closest('li').textContent).toMatch(/1,120/); // Balance due keeps old due
    // b: old ₹500 + bill ₹60 − paid ₹100 = ₹460 due. Payment clears old dues first, so the bill ₹60 is still unpaid.
    const b = byName('Mini singh');
    expect(b.textContent).toMatch(/₹60/);
    expect(b.className).toBe('due');
    expect(b.closest('li').textContent).toMatch(/460/);
  });
  it('header = remaining total when it is less than the month bill; green ₹0 when all clear', () => {
    const pays = [{ id: 'p2', customerId: 'a', amountPaise: 105000, date: '2026-10-05', mode: 'cash' }, { id: 'p3', customerId: 'b', amountPaise: 56000, date: '2026-10-05', mode: 'cash' }];
    render(wrap(<Hisaab fb={{}} customers={customers} days={days} payments={pays} settings={{ milkRatePaise: 6000 }} month="2026-10" setMonth={() => {}} openCustomer={() => {}} />));
    const heads = screen.getAllByTestId('row-balance');
    const byName = (n) => heads.find((h) => h.closest('li').textContent.includes(n));
    expect(byName('Aadil G').textContent).toMatch(/₹70/); // 1000 + 120 − 1050 = 70
    expect(byName('Mini singh').className).toBe('clear');
    // 1.10.66: paid customer shows the amount paid (₹560) and a PAID stamp; unpaid has no stamp
    expect(byName('Mini singh').textContent).toMatch(/560/);
    const stamps = screen.getAllByTestId('paid-stamp');
    expect(stamps).toHaveLength(1);
    expect(stamps[0].closest('li').textContent).toContain('Mini singh');
    expect(stamps[0].textContent).toContain('PAID');
  });
});

import { defaultCustomerMonth } from '../src/firstMonth.js';
describe('customer page opens on the month before the running month (1.10.67)', () => {
  it('previous month when the farm has older deliveries, else the running month', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 3, 10, 0));
    expect(defaultCustomerMonth({ '2026-09-02': { entries: { a: { milkL: 1 } } } })).toBe('2026-10');
    expect(defaultCustomerMonth({ '2026-11-02': { entries: { a: { milkL: 1 } } } })).toBe('2026-11');
    expect(defaultCustomerMonth({})).toBe('2026-11');
    vi.setSystemTime(new Date(2027, 0, 5, 10, 0));
    expect(defaultCustomerMonth({ '2026-09-02': { entries: { a: { milkL: 1 } } } })).toBe('2026-12');
    vi.useRealTimers();
  });
});
