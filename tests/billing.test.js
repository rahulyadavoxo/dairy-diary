import { describe, it, expect } from 'vitest';
import { toMilli, amountPaise, entryCharge, computeMonth, sortByDue, fullPaymentPaise } from '../src/billing.js';
import { rupees, toPaise, waNumber, dmy, addMonths, daysInMonth } from '../src/format.js';

const settings = { milkRatePaise: 6000, paneerRatePaise: 40000 }; // ₹60/L, ₹400/kg

describe('quantity + amount math (integer paise)', () => {
  it('converts litres to ml without float drift', () => {
    expect(toMilli(0.1 + 0.2)).toBe(300);
    expect(toMilli('1.5')).toBe(1500);
    expect(toMilli(-2)).toBe(0);
    expect(toMilli('')).toBe(0);
  });
  it('multiplies quantity by rate in paise', () => {
    expect(amountPaise(1500, 6000)).toBe(9000); // 1.5 L x ₹60 = ₹90
    expect(amountPaise(250, 40000)).toBe(10000); // 250 g paneer x ₹400/kg = ₹100
    expect(amountPaise(333, 5550)).toBe(1848); // rounds to nearest paisa
  });
  it('summing 0.1 L thirty times is exactly 3 L', () => {
    let ml = 0;
    for (let i = 0; i < 30; i++) ml += toMilli(0.1);
    expect(ml).toBe(3000);
    expect(amountPaise(ml, 5550)).toBe(16650);
  });
});

describe('entryCharge', () => {
  const c = { id: 'a' };
  it('skip means no milk but paneer still counts', () => {
    const ch = entryCharge({ milkL: 2, paneerKg: 0.5, skip: true }, c, settings);
    expect(ch.milkPaise).toBe(0);
    expect(ch.paneerPaise).toBe(20000);
  });
  it('uses customer override, then snapshot rate on the entry', () => {
    expect(entryCharge({ milkL: 1 }, { id: 'a', rateOverridePaise: 5500 }, settings).milkPaise).toBe(5500);
    expect(entryCharge({ milkL: 1, milkRatePaise: 5000 }, { id: 'a', rateOverridePaise: 5500 }, settings).milkPaise).toBe(5000);
  });
});

describe('computeMonth: carry-forward and part payments', () => {
  const customers = [
    { id: 'a', name: 'Amit', openingDuePaise: 50000 }, // ₹500 old due from paper register
    { id: 'b', name: 'Bablu' },
    { id: 'c', name: 'Chhotu', rateOverridePaise: 5500 },
  ];
  const days = {
    '2026-09-30': { entries: { a: { milkL: 2 }, b: { milkL: 1 } } },
    '2026-10-01': { entries: { a: { milkL: 2 }, b: { milkL: 1.5, paneerKg: 0.25 }, c: { milkL: 1 } } },
    '2026-10-02': { entries: { a: { milkL: 2, skip: true }, b: { milkL: 1.5 }, c: { milkL: 1 } } },
    '2026-11-01': { entries: { a: { milkL: 5 } } }, // future month: ignored
  };
  const payments = [
    { customerId: 'a', date: '2026-09-30', amountPaise: 30000 }, // paid ₹300 in Sept
    { customerId: 'a', date: '2026-10-05', amountPaise: 10000 }, // part payment ₹100
    { customerId: 'b', date: '2026-10-10', amountPaise: 6000 },
    { customerId: 'b', date: '2026-10-11', amountPaise: 3000 }, // two part payments
    { customerId: 'c', date: '2026-10-02', amountPaise: 20000 }, // overpaid -> advance
  ];
  const res = computeMonth({ customers, days, payments, settings, month: '2026-10' });
  const row = (id) => res.rows.find((r) => r.customerId === id);

  it('carries forward previous due = opening + earlier bills - earlier payments', () => {
    // a: 500 + (2L*60=120) - 300 = 320
    expect(row('a').previousDuePaise).toBe(32000);
    // b: 1L*60 = 60
    expect(row('b').previousDuePaise).toBe(6000);
    expect(row('c').previousDuePaise).toBe(0);
  });
  it('bills only this month and respects skip', () => {
    expect(row('a').milkMl).toBe(2000);
    expect(row('a').milkPaise).toBe(12000);
    expect(row('b').milkMl).toBe(3000);
    expect(row('b').paneerG).toBe(250);
    expect(row('b').paneerPaise).toBe(10000);
    expect(row('b').billedPaise).toBe(28000);
    expect(row('c').milkPaise).toBe(11000); // override ₹55
  });
  it('applies part payments to the balance', () => {
    expect(row('a').paidPaise).toBe(10000);
    expect(row('a').balancePaise).toBe(32000 + 12000 - 10000); // ₹340
    expect(row('b').paidPaise).toBe(9000);
    expect(row('b').balancePaise).toBe(6000 + 28000 - 9000); // ₹250
    expect(row('c').balancePaise).toBe(11000 - 20000); // -₹90 advance
  });
  it('totals: billed, collected, pending, advance', () => {
    expect(res.totals.billedPaise).toBe(12000 + 28000 + 11000);
    expect(res.totals.collectedPaise).toBe(10000 + 9000 + 20000);
    expect(res.totals.pendingPaise).toBe(34000 + 25000);
    expect(res.totals.advancePaise).toBe(9000);
  });
  it('next month carries the balance forward exactly', () => {
    const nov = computeMonth({ customers, days, payments, settings, month: '2026-11' });
    const a = nov.rows.find((r) => r.customerId === 'a');
    expect(a.previousDuePaise).toBe(34000);
    expect(a.billedPaise).toBe(30000);
    expect(a.balancePaise).toBe(64000);
    const c = nov.rows.find((r) => r.customerId === 'c');
    expect(c.previousDuePaise).toBe(-9000); // advance carried as credit
  });
  it('sorts by highest due', () => {
    expect(sortByDue(res.rows).map((r) => r.customerId)).toEqual(['a', 'b', 'c']);
  });
  it('full payment clears the balance to zero', () => {
    const a = row('a');
    const pay = fullPaymentPaise(a.balancePaise);
    const after = computeMonth({ customers, days, payments: [...payments, { customerId: 'a', date: '2026-10-31', amountPaise: pay }], settings, month: '2026-10' });
    expect(after.rows.find((r) => r.customerId === 'a').balancePaise).toBe(0);
    expect(fullPaymentPaise(-500)).toBe(0);
  });
});

describe('format helpers', () => {
  it('formats rupees in Indian style', () => {
    expect(rupees(12345600)).toBe('₹1,23,456');
    expect(rupees(12345650)).toBe('₹1,23,456.50');
    expect(rupees(-9000)).toBe('-₹90');
  });
  it('parses rupee input to paise', () => {
    expect(toPaise('60')).toBe(6000);
    expect(toPaise('55.5')).toBe(5550);
    expect(toPaise('1,200')).toBe(120000);
    expect(toPaise('')).toBe(null);
  });
  it('dates and phones', () => {
    expect(dmy('2026-10-13')).toBe('13 October 2026');
    expect(dmy('2026-10-05', 'hi')).toBe('5 अक्टूबर 2026');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(daysInMonth('2028-02')).toBe(29);
    expect(waNumber('98765 43210')).toBe('919876543210');
    expect(waNumber('+91 98765 43210')).toBe('919876543210');
  });
});
