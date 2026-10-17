// 1.10.51: delivery format setting (split / total / both)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../src/feedback.js', () => ({ playSound: () => {}, vibrateFail: () => {}, saveFeedback: (ok) => ok }));

import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { todayISO, addDays } from '../src/format.js';
import Delivery, { TAP_GUARD_MS, deliveryFormat, roundFor, totalInit } from '../src/screens/Delivery.jsx';
import Settings from '../src/screens/Settings.jsx';
import { resetCustomersView } from '../src/screens/Customers.jsx';

const en = STRINGS.en;
const settings = { milkRatePaise: 6000, paneerRatePaise: 40000 };
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
function mkFb() {
  const writes = [];
  const ref = (...parts) => ({ path: parts.filter((p) => typeof p === 'string').join('/'), id: parts[parts.length - 1] });
  return {
    writes, farmId: 'f', db: {},
    fsMod: {
      doc: (...a) => (a.length === 1 ? { path: a[0].path + '/new', id: 'new' } : ref(...a.slice(1))),
      collection: (...a) => ref(...a.slice(1)),
      setDoc: vi.fn(async (r, data) => writes.push({ path: r.path, data })),
      updateDoc: vi.fn(async (r, data) => writes.push({ path: r.path, data, update: true })),
      deleteField: () => 'DEL',
      writeBatch: () => ({ update: () => {}, set: () => {}, commit: async () => {} }),
    },
  };
}
const lastEntry = (fb, id) => fb.writes.filter((w) => w.path.startsWith('farms/f/days/')).at(-1).data.entries[id];
const both = { id: 'c1', name: 'Asha', order: 10, usualMorningL: 1, usualEveningL: 1.5 };
const eveOnly = { id: 'c3', name: 'Rinku', order: 30, usualMorningL: 0, usualEveningL: 1.25 };
const mornOnly = { id: 'c2', name: 'Bablu', order: 20, usualMorningL: 1, usualEveningL: 0 };
const box = (id) => screen.getByTestId(id);
const plus = (id) => fireEvent.click(box(id).querySelectorAll('button')[1]);
const input = (id) => box(id).querySelector('input');
let now = 1_000_000;
beforeEach(() => {
  cleanup(); localStorage.clear(); resetCustomersView(); now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());
const tap = (el) => { now += TAP_GUARD_MS + 1; fireEvent.click(el); };
const T = todayISO();
const props = (fb, customers, extra = {}, days = {}) => ({ fb, customers, days, settings: { ...settings, ...extra }, displayName: 'x', onBack: () => {} });

describe('1.10.51 delivery format', () => {
  it('defaults to both; morning round until 14:00', () => {
    expect(deliveryFormat({})).toBe('both');
    expect(deliveryFormat({ deliveryFormat: 'zzz' })).toBe('both');
    expect(deliveryFormat({ deliveryFormat: 'split' })).toBe('split');
    expect(roundFor(new Date(2026, 9, 17, 9))).toBe('morning');
    expect(roundFor(new Date(2026, 9, 17, 17))).toBe('evening');
    expect(totalInit(undefined, both)).toBe(2.5);
    expect(totalInit({ milkMorningL: 1, milkEveningL: 0, half: 'morning' }, both)).toBe(2.5);
  });

  it('both: the old card with morning, evening and total', () => {
    render(wrap(<Delivery {...props(mkFb(), [both])} />));
    expect(screen.queryByTestId('qty-morning')).not.toBeNull();
    expect(screen.queryByTestId('qty-evening')).not.toBeNull();
    expect(screen.queryByTestId('qty-total')).not.toBeNull();
    expect(screen.queryByTestId('round-morning')).toBeNull();
  });

  it('total: only the Total box; saves a total-only entry', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb, [both], { deliveryFormat: 'total' })} />));
    expect(screen.queryByTestId('qty-morning')).toBeNull();
    expect(screen.queryByTestId('qty-evening')).toBeNull();
    expect(input('qty-total').value).toBe('2.5');
    plus('qty-total');
    tap(screen.getByText(en.delivered));
    expect(lastEntry(fb, 'c1')).toMatchObject({ milkL: 2.75 }); // (only changed fields are written)
    const w = lastEntry(fb, 'c1');
    expect((w.milkMorningL || 0) + (w.milkEveningL || 0)).toBe(0);
  });

  it('split morning: only the morning box; saved as half so the evening round still has it', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb, [both, mornOnly, eveOnly], { deliveryFormat: 'split' })} />));
    tap(screen.getByTestId('round-morning'));
    expect(screen.queryByTestId('qty-evening')).toBeNull();
    expect(screen.queryByTestId('qty-total')).toBeNull();
    expect(screen.getByText('Asha')).toBeTruthy();
    expect(input('qty-morning').value).toBe('1');
    tap(screen.getByText(en.delivered));
    const e = lastEntry(fb, 'c1');
    expect(e.milkMorningL).toBe(1);
    expect(e.milkEveningL || 0).toBe(0);
    expect(e.half).toBe('morning');
    // evening-only customer is not on the morning round
    expect(screen.getByText('Bablu')).toBeTruthy();
    tap(screen.getByText(en.delivered));
    expect(screen.queryByText('Rinku')).toBeNull();
  });

  it('split evening: keeps the morning milk; Absent zeroes only the evening', () => {
    const fb = mkFb();
    const days = { [T]: { entries: { c1: { milkL: 1, milkMorningL: 1, milkEveningL: 0, half: 'morning' }, c3: { milkL: 0 } } } };
    render(wrap(<Delivery {...props(fb, [both, eveOnly], { deliveryFormat: 'split' }, days)} />));
    tap(screen.getByTestId('round-evening'));
    expect(screen.queryByTestId('qty-morning')).toBeNull();
    expect(input('qty-evening').value).toBe('1.5');
    tap(screen.getByText(en.delivered));
    const e = lastEntry(fb, 'c1');
    expect(e).toMatchObject({ milkL: 2.5, milkEveningL: 1.5 }); // morning 1 kept (unchanged, not rewritten)
    expect(e.milkMorningL ?? 1).toBe(1);
    expect(e.half || null).toBeNull();
    expect(screen.getByText('Rinku')).toBeTruthy();
    tap(screen.getByText(en.absent));
    const r = lastEntry(fb, 'c3');
    expect(r.skip).toBeFalsy();
    expect(r.milkEveningL || 0).toBe(0);
  });

  it('Settings: three toggle bars, only one on; tapping another saves it', () => {
    const fb = mkFb();
    render(wrap(<Settings fb={fb} user={{}} settings={{ deliveryFormat: 'total' }} displayName="x" setDisplayName={() => {}} online farm={{}} farmId="f" />));
    expect(screen.getByTestId('deli-fmt-total').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('deli-fmt-split').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('deli-fmt-both').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByTestId('deli-fmt-total')); // can't switch the only one off
    expect(fb.writes.some((w) => w.data && w.data.deliveryFormat)).toBe(false);
    fireEvent.click(screen.getByTestId('deli-fmt-split'));
    expect(fb.writes.find((w) => w.data && w.data.deliveryFormat).data.deliveryFormat).toBe('split');
  });
});
