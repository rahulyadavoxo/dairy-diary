// 1.10.30: once-a-day customers never get "Evening left"; evening box shows the usual number;
// "As usual" hides once morning or evening is edited.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../src/feedback.js', () => ({ playSound: () => {}, vibrateFail: () => {}, saveFeedback: (ok) => ok }));

import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { todayISO, addDays } from '../src/format.js';
import Delivery, { dayComplete, initEvening, TAP_GUARD_MS } from '../src/screens/Delivery.jsx';
import { resetCustomersView } from '../src/screens/Customers.jsx';
import RegisterView from '../src/screens/RegisterView.jsx';
import { entryComplete, takesTwice } from '../src/entry.js';

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
const props = (fb, customers) => ({ fb, customers, days: {}, settings, displayName: 'x', onBack: () => {} });

describe('1.10.30 once-a-day customers and the evening box', () => {
  it('takesTwice / entryComplete / dayComplete treat once-a-day customers as complete', () => {
    expect([takesTwice(both), takesTwice(eveOnly), takesTwice(mornOnly)]).toEqual([true, false, false]);
    const half = { milkL: 1, milkMorningL: 1, milkEveningL: 0, half: 'morning' };
    expect(entryComplete(half, both)).toBe(false);
    expect(entryComplete(half, mornOnly)).toBe(true);
    expect(dayComplete(half, mornOnly)).toBe(true);
    expect(dayComplete(half, both)).toBe(false);
    expect(initEvening(undefined, eveOnly)).toBe(1.25);
    expect(initEvening(undefined, both)).toBe(1.5);
  });
  it('evening-only customer: evening box pre-filled, Delivered completes the day', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb, [eveOnly])} />));
    expect(input('qty-evening').value).toBe('1.25');
    tap(screen.getByText(en.delivered));
    const e = lastEntry(fb, 'c3');
    expect(e.milkEveningL).toBe(1.25);
    expect(e.half).toBeFalsy();
  });
  it('twice-a-day customer: evening box holds the usual number, editable; cleared = morning only', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb, [both])} />));
    expect(input('qty-evening').value).toBe('1.5');
    fireEvent.change(input('qty-evening'), { target: { value: '2' } });
    expect(input('qty-evening').value).toBe('2');
    fireEvent.change(input('qty-evening'), { target: { value: '' } });
    expect(input('qty-evening').value).toBe('');
    tap(screen.getByText(en.delivered));
    expect(lastEntry(fb, 'c1').half).toBe('morning');
  });
  it('As usual hides once morning or evening is edited', () => {
    render(wrap(<Delivery {...props(mkFb(), [both])} />));
    expect(screen.queryByTestId('as-usual-btn')).not.toBeNull();
    plus('qty-morning');
    expect(screen.queryByTestId('as-usual-btn')).toBeNull();
  });
  it('As usual hides after editing the evening too', () => {
    render(wrap(<Delivery {...props(mkFb(), [both])} />));
    plus('qty-evening');
    expect(screen.queryByTestId('as-usual-btn')).toBeNull();
  });
  it('Register: no Evening left tag for a once-a-day customer, counted as filled', () => {
    const half = { milkL: 1, milkMorningL: 1, milkEveningL: 0, half: 'morning' };
    const days = { [addDays(T, -1)]: { entries: { c1: { milkL: 1 }, c2: { milkL: 1 } } }, [T]: { entries: { c1: { ...half }, c2: { ...half } } } };
    render(wrap(<RegisterView fb={mkFb()} customers={[both, mornOnly]} days={days} pendingDays={{}} settings={settings} displayName="x" onDelivery={() => {}} />));
    expect(screen.getAllByTestId('eve-pending')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('edit-day'));
    expect(screen.getByRole('alert').textContent).toBe(en.editDayNeedsAll.replace('{n}', 1));
  });
});
