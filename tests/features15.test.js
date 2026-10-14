// v1.5 feature tests: session entries, usual quantities, bill prompt logic.
import { describe, it, expect } from 'vitest';
import { normaliseEntry } from '../src/entry.js';
import { usualMorning, usualEvening } from '../src/screens/Customers.jsx';
import { shouldPromptBills } from '../src/screens/BillSender.jsx';
import { todayISO, monthOf } from '../src/format.js';

const settings = { milkRatePaise: 6000, paneerRatePaise: 40000 };
const customer = { id: 'c1', name: 'Test' };

describe('normaliseEntry (session split)', () => {
  it('sums morning + evening into milkL', () => {
    const e = normaliseEntry(customer, { milkMorningL: 1.5, milkEveningL: 2, paneerKg: 0 }, settings);
    expect(e.milkL).toBe(3.5);
    expect(e.milkMorningL).toBe(1.5);
    expect(e.milkEveningL).toBe(2);
    expect(e.milkRatePaise).toBe(6000);
  });
  it('total mode (null sessions) keeps milkL as-is', () => {
    const e = normaliseEntry(customer, { milkL: 4, milkMorningL: null, milkEveningL: null }, settings);
    expect(e.milkL).toBe(4);
  });
  it('legacy entries (only milkL) keep working', () => {
    const e = normaliseEntry(customer, { milkL: 2.5 }, settings);
    expect(e.milkL).toBe(2.5);
    expect(e.milkMorningL).toBe(0);
    expect(e.milkEveningL).toBe(0);
  });
  it('rounds to millilitres, no float dust', () => {
    const e = normaliseEntry(customer, { milkMorningL: 0.1, milkEveningL: 0.2 }, settings);
    expect(e.milkL).toBe(0.3);
  });
});

describe('usualMorning / usualEvening', () => {
  it('uses the session fields when set', () => {
    const c = { usualMorningL: 1.5, usualEveningL: 2.5, usualL: 4 };
    expect(usualMorning(c)).toBe(1.5);
    expect(usualEvening(c)).toBe(2.5);
  });
  it('falls back to half of legacy usualL', () => {
    const c = { usualL: 3 };
    expect(usualMorning(c)).toBe(1.5);
    expect(usualEvening(c)).toBe(1.5);
  });
  it('returns 0 when nothing is set', () => {
    expect(usualMorning({})).toBe(0);
    expect(usualEvening({})).toBe(0);
  });
});

describe('shouldPromptBills', () => {
  it('is true only on the 1st and only if not already sent', () => {
    const today = todayISO();
    const isFirst = today.slice(8, 10) === '01';
    const cur = monthOf(today);
    expect(shouldPromptBills({})).toBe(isFirst);
    expect(shouldPromptBills({ billsSentForMonth: cur })).toBe(false);
    expect(shouldPromptBills({ billsSentForMonth: '2000-01' })).toBe(isFirst);
  });
});
