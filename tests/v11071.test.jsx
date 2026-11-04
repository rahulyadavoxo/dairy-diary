// 1.10.71 (user, 4 Nov 2026): on a past month the advance is beyond THAT month's due, not today's total.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import CustomerDetail from '../src/screens/CustomerDetail.jsx';
import { LangContext, makeT } from '../src/i18n.js';
import { todayISO, addMonths } from '../src/format.js';

describe('past month advance', () => {
  afterEach(() => cleanup());
  it('Oct due 866.25 + this month 82.50: typing 1000 on Oct shows 133.75 advance', () => {
    const cur = todayISO().slice(0, 7);
    const prev = addMonths(cur, -1);
    const days = {
      [prev + '-05']: { entries: { a: { milkL: 15.75, milkRatePaise: 5500 } } },
      [cur + '-01']: { entries: { a: { milkL: 1.5, milkRatePaise: 5500 } } },
    };
    render(
      <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>
        <CustomerDetail fb={{ farmId: 'F', fsMod: {} }} customers={[{ id: 'a', name: 'Mintu' }]} days={days} payments={[]}
          settings={{ milkRatePaise: 5500 }} month={prev} setMonth={() => {}} customerId="a" onBack={() => {}} displayName="me" />
      </LangContext.Provider>,
    );
    fireEvent.change(document.querySelector('form.pay input[type="number"]'), { target: { value: '1000' } });
    expect(screen.getByTestId('pay-hint').textContent).toContain('133.75');
    expect(screen.getByTestId('pay-submit').textContent).toContain('133.75');
  });
});
