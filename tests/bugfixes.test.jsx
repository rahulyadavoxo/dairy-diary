// Regression tests for the bugs listed in BUG_REPORT.txt
import { describe, it, expect, beforeEach } from 'vitest';
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

// ---- 1.9.4 review ----
import { migrateLegacyPin, getPinHash as _getPin, savePinHash as _savePin } from '../src/pinLock.js';
describe('1.9.4 PIN move to localStorage', () => {
  beforeEach(() => localStorage.clear());
  it('copies an old Firestore PIN to this phone once', () => {
    expect(migrateLegacyPin({ totalsPinHash: 'abc' })).toBe(true);
    expect(_getPin()).toBe('abc');
  });
  it('does not bring back a PIN the user removed on this phone', () => {
    migrateLegacyPin({ totalsPinHash: 'abc' });
    _savePin('');
    migrateLegacyPin({ totalsPinHash: 'abc' });
    expect(_getPin()).toBe('');
  });
  it('waits for settings to load before deciding', () => {
    expect(migrateLegacyPin({})).toBe(false);
    expect(migrateLegacyPin({ totalsPinHash: 'x' })).toBe(true);
    expect(_getPin()).toBe('x');
  });
});

// ---- 1.9.5 review ----
import { verifyPin as _verify, hashPin as _hash, pinWaitSeconds as _wait } from '../src/pinLock.js';
describe('1.9.5 wrong-PIN throttle', () => {
  beforeEach(() => localStorage.clear());
  it('blocks guessing after 5 wrong PINs, even the right one, until the wait ends', async () => {
    _savePin(await _hash('4321'));
    for (let i = 0; i < 5; i++) expect(await _verify('0000')).toBe(false);
    expect(_wait()).toBe(0); // 5 free tries
    expect(await _verify('1111')).toBe(false);
    expect(_wait()).toBeGreaterThan(0);
    expect(await _verify('4321')).toBe(false);
  });
  it('a correct PIN resets the counter', async () => {
    _savePin(await _hash('4321'));
    for (let i = 0; i < 4; i++) await _verify('0000');
    expect(await _verify('4321')).toBe(true);
    for (let i = 0; i < 5; i++) await _verify('0000');
    expect(_wait()).toBe(0);
  });
});
