// Regression tests for the bugs listed in BUG_REPORT.txt
import { describe, it, expect } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { normaliseEntry } from '../src/entry.js';
import { usualMorning } from '../src/screens/Customers.jsx';
import { parseImportList } from '../src/importList.js';
import { deviceStatus } from '../src/devices.js';
import { billFingerprint } from '../src/billImage.js';
import { LangContext, makeT } from '../src/i18n.js';
import CustomerDetail from '../src/screens/CustomerDetail.jsx';
import BillSender from '../src/screens/BillSender.jsx';
import { addMonths, monthOf, todayISO } from '../src/format.js';

const settings = { milkRatePaise: 6000, paneerRatePaise: 40000 };

describe('BUG-01 re-saving a total-mode entry must not wipe the milk', () => {
  it('stored 0+0 split keeps milkL', () => {
    const saved = normaliseEntry({}, { milkL: 2, milkMorningL: null, milkEveningL: null }, settings);
    expect(normaliseEntry({}, { ...saved, note: 'late' }, settings).milkL).toBe(2);
    expect(normaliseEntry({}, { ...saved, paneerKg: 0.5 }, settings).milkL).toBe(2);
  });
  it('pre-filled usual row (Save all) keeps the usual litres', () => {
    expect(normaliseEntry({}, { milkL: 1.5, milkMorningL: null, milkEveningL: null }, settings).milkL).toBe(1.5);
    expect(normaliseEntry({}, { milkL: 1.5, milkMorningL: 0, milkEveningL: 0 }, settings).milkL).toBe(1.5);
  });
  it('session-only input still defines the total', () => {
    expect(normaliseEntry({}, { milkMorningL: 1, milkEveningL: 0.5 }, settings).milkL).toBe(1.5);
    expect(normaliseEntry({}, { milkMorningL: 0, milkEveningL: 0 }, settings).milkL).toBe(0);
  });
});

describe('small helpers', () => {
  it('usualMorning: null field falls back to legacy usualL', () => {
    expect(usualMorning({ usualMorningL: null, usualL: 3 })).toBe(1.5);
  });
  it('parseImportList: empty quantity field uses the 0.5 default', () => {
    expect(parseImportList('Ram, , 1')[0]).toEqual({ name: 'Ram', morningL: 0.5, eveningL: 1 });
  });
  it('deviceStatus: a network error is not "noFarm"', () => {
    expect(deviceStatus({ loaded: true, exists: false, denied: false, error: { code: 'unavailable' } }, 'u')).toBe('error');
  });
  it('bill photo fingerprint changes when the previous due changes', () => {
    const row = { customer: { name: 'A' }, milkMl: 1000, milkPaise: 6000, paneerG: 0, paneerPaise: 0, billedPaise: 6000, previousDuePaise: 0, paidPaise: 0, balancePaise: 6000, milkRates: new Set([6000]), daily: {} };
    expect(billFingerprint(row, settings)).not.toBe(billFingerprint({ ...row, previousDuePaise: 500 }, settings));
  });
});

const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;

describe('BUG-02/03 Rules of Hooks crashes', () => {
  it('CustomerDetail survives the customer disappearing and coming back', () => {
    cleanup();
    const c = { id: 'c1', name: 'Ram' };
    const props = { fb: {}, days: {}, payments: [], settings, displayName: 'x', customerId: 'c1', month: '2026-10', setMonth: () => {}, onBack: () => {} };
    const r = render(wrap(<CustomerDetail {...props} customers={[c]} />));
    expect(() => r.rerender(wrap(<CustomerDetail {...props} customers={[]} />))).not.toThrow();
    expect(() => r.rerender(wrap(<CustomerDetail {...props} customers={[c]} />))).not.toThrow();
  });
  it('BillSender survives moving past the last customer', () => {
    cleanup();
    const bm = addMonths(monthOf(todayISO()), -1);
    const c = { id: 'c1', name: 'Ram', phone: '9999999999' };
    const days = { [`${bm}-05`]: { entries: { c1: { milkL: 1 } } } };
    localStorage.setItem('dd_wa_progress', JSON.stringify({ month: bm, idx: 0 }));
    const props = { fb: {}, days, payments: [], settings, onClose: () => {} };
    const r = render(wrap(<BillSender {...props} customers={[c]} />));
    // customer becomes inactive -> targets empty -> early return path; must not crash
    expect(() => r.rerender(wrap(<BillSender {...props} customers={[{ ...c, active: false }]} />))).not.toThrow();
  });
});
