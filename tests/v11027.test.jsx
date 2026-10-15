// 1.10.27: a morning-only Delivery save keeps the day incomplete until the evening (or a Total) is saved.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const fx = vi.hoisted(() => ({ sounds: [], fails: 0 }));
vi.mock('../src/feedback.js', () => ({
  playSound: (n) => fx.sounds.push(n),
  vibrateFail: () => {
    fx.fails += 1;
  },
  saveFeedback: (ok) => {
    if (ok) fx.sounds.push('save');
    else fx.fails += 1;
    return ok;
  },
}));

import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { todayISO, addDays } from '../src/format.js';
import Delivery, { dayComplete, TAP_GUARD_MS } from '../src/screens/Delivery.jsx';
import Customers, { resetCustomersView } from '../src/screens/Customers.jsx';
import { useScrollKeep } from '../src/scrollKeep.js';
import { handleBack } from '../src/backStack.js';
import { act } from '@testing-library/react';
import RegisterView from '../src/screens/RegisterView.jsx';

const en = STRINGS.en;
const settings = { milkRatePaise: 6000, paneerRatePaise: 40000 };
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
function mkFb() {
  const writes = [];
  const ref = (...parts) => ({ path: parts.filter((p) => typeof p === 'string').join('/'), id: parts[parts.length - 1] });
  return {
    writes,
    farmId: 'f',
    db: {},
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
const dayWrites = (fb) => fb.writes.filter((w) => w.path.startsWith('farms/f/days/'));
const lastEntry = (fb, id) => dayWrites(fb).at(-1).data.entries[id];

const c1 = { id: 'c1', name: 'Asha', order: 10, usualMorningL: 1, usualEveningL: 1 };
const c2 = { id: 'c2', name: 'Bablu', order: 20, usualMorningL: 1, usualEveningL: 0 };
const sup = { id: 's1', name: 'Supplier Sharma', order: 15, usualMorningL: 20, usualEveningL: 0, isSupplier: true };
const props = (fb, extra = {}) => ({ fb, customers: [c1, sup, c2], days: {}, settings, displayName: 'x', onBack: () => {}, ...extra });
const box = (id) => screen.getByTestId(id);
const plus = (id) => fireEvent.click(box(id).querySelectorAll('button')[1]);
const minus = (id) => fireEvent.click(box(id).querySelectorAll('button')[0]);
const val = (id) => box(id).querySelector('input').value;

let now = 1_000_000;
beforeEach(() => {
  cleanup();
  localStorage.clear();
  fx.sounds = [];
  fx.fails = 0;
  resetCustomersView();
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());
const tap = (el) => {
  now += TAP_GUARD_MS + 1;
  fireEvent.click(el);
};

const T = todayISO();
describe('1.10.27 morning only stays incomplete', () => {
  it('evening box starts empty; Delivered saves the morning only (half) and moves on', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb)} />));
    expect([val('qty-morning'), val('qty-evening')]).toEqual(['1', '']);
    tap(screen.getByText(en.delivered));
    const e = lastEntry(fb, 'c1');
    expect([e.milkMorningL, e.milkL, e.half]).toEqual([1, 1, 'morning']);
    expect(dayComplete({ ...e, milkEveningL: 0 }, c1)).toBe(false);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Supplier');
  });
  it('a customer who takes no evening milk is complete with the morning', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb, { customers: [c2] })} />));
    expect(val('qty-evening')).toBe('0');
    tap(screen.getByText(en.delivered));
    expect(lastEntry(fb, 'c2').half).toBeFalsy();
  });
  it('evening visit: morning kept, As usual fills the evening and completes the day', () => {
    const fb = mkFb();
    const days = { [T]: { entries: { c1: { milkL: 1, milkMorningL: 1, milkEveningL: 0, half: 'morning' } } } };
    render(wrap(<Delivery {...props(fb, { days, customers: [c1] })} />));
    expect([val('qty-morning'), val('qty-evening')]).toEqual(['1', '']);
    tap(screen.getByText(en.asUsual, { selector: 'button' }));
    const e = { ...days[T].entries.c1, ...lastEntry(fb, 'c1') };
    expect([e.milkMorningL, e.milkEveningL, e.milkL, e.half]).toEqual([1, 1, 2, null]);
  });
  it('a Total completes the day at once', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb, { customers: [c1] })} />));
    plus('qty-total');
    tap(screen.getByText(en.delivered));
    const e = lastEntry(fb, 'c1');
    expect(e.milkL).toBe(0.25);
    expect(e.half).toBeFalsy();
  });
  it('Register: a morning-only customer is still counted for Edit this day and tagged Evening left', () => {
    const days = { [addDays(T, -1)]: { entries: { c1: { milkL: 1 }, c2: { milkL: 1 } } }, [T]: { entries: { c1: { milkL: 1, milkMorningL: 1, milkEveningL: 0, half: 'morning' }, c2: { milkL: 1, milkMorningL: 1, milkEveningL: 0 } } } };
    render(wrap(<RegisterView fb={mkFb()} customers={[c1, c2]} days={days} pendingDays={{}} settings={settings} displayName="x" onDelivery={() => {}} />));
    expect(screen.getAllByTestId('eve-pending')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('edit-day'));
    expect(screen.getByRole('alert').textContent).toBe(en.editDayNeedsAll.replace('{n}', 1));
  });
});
