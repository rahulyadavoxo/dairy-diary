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
    const b = byName('Mini singh');
    expect(b.textContent).toMatch(/₹0/);
    expect(b.className).toBe('clear');
    expect(b.closest('li').textContent).toMatch(/460/);
  });
});
