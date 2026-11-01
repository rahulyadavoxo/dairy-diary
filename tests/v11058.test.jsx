// 1.10.58: WhatsApp bills follow the month open in Hisaab (current month by default).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
vi.mock('../src/db.js', async (orig) => ({ ...(await orig()), saveSettings: vi.fn(() => Promise.resolve()) }));
import BillSender from '../src/screens/BillSender.jsx';
import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { addMonths, monthOf, todayISO, monthName } from '../src/format.js';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
const cur = monthOf(todayISO());
const prev = addMonths(cur, -1);
const cust = [{ id: 'a', name: 'A', phone: '9876543210' }];
const days = { [`${cur}-01`]: { entries: { a: { milkL: 1 } } }, [`${prev}-02`]: { entries: { a: { milkL: 2 } } } };
const props = { fb: {}, customers: cust, days, payments: [], settings: { milkRatePaise: 6000 }, onClose: () => {} };
afterEach(cleanup);

describe('BillSender month', () => {
  it('uses the month it is given (current month)', () => {
    render(wrap(<BillSender {...props} month={cur} />));
    expect(document.body.textContent).toContain(monthName(cur, 'en'));
    expect(document.body.textContent).not.toContain(en.waLastDayEmpty || '@@none@@');
  });
  it('falls back to last month without a month prop', () => {
    const a = render(wrap(<BillSender {...props} />)).container.textContent;
    cleanup();
    const b = render(wrap(<BillSender {...props} month={prev} />)).container.textContent;
    expect(a).toBe(b);
    cleanup();
    const c = render(wrap(<BillSender {...props} month={cur} />)).container.textContent;
    expect(c).not.toBe(b);
  });
});
