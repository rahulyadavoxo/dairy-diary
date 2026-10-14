// v1.10.2: Hisaab search + Paid/Unpaid filter + compact toolbar
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../src/billPreGen.js', () => ({ preGenerateBillPhotos: vi.fn() }));
vi.mock('../src/billImage.js', async (orig) => ({ ...(await orig()), renderBillImage: vi.fn(), shareImage: vi.fn() }));

import Hisaab, { resetHisaabView } from '../src/screens/Hisaab.jsx';
import { LangContext, makeT, STRINGS } from '../src/i18n.js';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
const customers = [
  { id: 'a', name: 'Aadil G', area: 'Station road' },
  { id: 'b', name: 'Mini singh' },
  { id: 'c', name: 'Ravi' },
];
const days = { '2026-10-01': { entries: { a: { milkL: 2 }, b: { milkL: 1 }, c: { milkL: 1 } } } };
const payments = [{ id: 'p1', customerId: 'c', amountPaise: 6000, date: '2026-10-02', mode: 'cash' }];
const view = () =>
  render(wrap(<Hisaab fb={{}} customers={customers} days={days} payments={payments} settings={{ milkRatePaise: 6000 }} month="2026-10" setMonth={() => {}} openCustomer={() => {}} />));
const names = () => ['Aadil G', 'Mini singh', 'Ravi'].filter((n) => screen.queryByText(n));

beforeEach(() => {
  resetHisaabView();
  cleanup();
  localStorage.clear();
});

describe('Hisaab search + paid/unpaid', () => {
  it('search filters by name and area', () => {
    view();
    expect(names()).toEqual(['Aadil G', 'Mini singh', 'Ravi']);
    const box = screen.getByPlaceholderText(en.search);
    fireEvent.change(box, { target: { value: 'mini' } });
    expect(names()).toEqual(['Mini singh']);
    fireEvent.change(box, { target: { value: 'station' } });
    expect(names()).toEqual(['Aadil G']);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText(en.noMatch)).toBeTruthy();
  });
  it('Unpaid / Paid chips with counts', () => {
    view();
    fireEvent.click(screen.getByText(`${en.filterUnpaid} (2)`));
    expect(names()).toEqual(['Aadil G', 'Mini singh']);
    fireEvent.click(screen.getByText(`${en.filterPaid} (1)`));
    expect(names()).toEqual(['Ravi']);
    fireEvent.click(screen.getByText(`${en.filterAll} (3)`));
    expect(names()).toHaveLength(3);
  });
  it('compact toolbar: WhatsApp, photos and show in one row', () => {
    const { container } = view();
    const row = container.querySelector('.tool-row');
    expect(row.querySelectorAll('button')).toHaveLength(3);
    expect(row.querySelector(`[aria-label="${en.waBillsShort}"] .icon-wa`)).toBeTruthy();
    expect(row.textContent).toContain(en.billPhotosShort);
  });
});
