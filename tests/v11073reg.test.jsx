// 1.10.73 register / delivery review fixes (#1-#9 of check/register.txt)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../src/feedback.js', () => ({ playSound: () => {}, vibrateFail: () => {}, saveFeedback: (ok) => ok }));

import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { todayISO } from '../src/format.js';
import { entryChanges } from '../src/db.js';
import { entryCharge } from '../src/billing.js';
import Delivery, { TAP_GUARD_MS, dayComplete, roundFor } from '../src/screens/Delivery.jsx';
import DayEditor from '../src/screens/Register.jsx';
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
const dayWrites = (fb) => fb.writes.filter((w) => w.path.startsWith('farms/f/days/'));
const lastEntry = (fb, id) => dayWrites(fb).at(-1).data.entries[id];
const twice = { id: 'c1', name: 'Asha', order: 10, usualMorningL: 1, usualEveningL: 1.5 };
const other = { id: 'c2', name: 'Bablu', order: 20, usualMorningL: 1, usualEveningL: 0 };
let now = 1_000_000;
beforeEach(() => {
  cleanup(); localStorage.clear(); resetCustomersView(); now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const tap = (el) => { now += TAP_GUARD_MS + 1; fireEvent.click(el); };
const props = (fb, customers, extra = {}, days = {}) => ({ fb, customers, days, settings: { ...settings, ...extra }, displayName: 'x', onBack: () => {} });

describe('#1 a new entry is written whole', () => {
  it('Total on a phone that has not seen the other phone\'s morning: no mix on the server', () => {
    const a = entryChanges(undefined, { milkL: 1, milkMorningL: 1, milkEveningL: 0, half: 'morning', skip: false });
    const b = entryChanges(undefined, { milkL: 3, milkMorningL: 0, milkEveningL: 0, half: null, skip: false });
    expect(b).toEqual({ milkL: 3, milkMorningL: 0, milkEveningL: 0, half: null, skip: false });
    const server = { ...a, ...b };
    expect(entryCharge(server, { id: 'c' }, {}).milkMl).toBe(3000);
    expect(server.half).toBeNull();
  });
});

describe('#3 milk fields are written together', () => {
  it('a morning edit writes milkL, evening, half and skip too', () => {
    const base = { milkL: 2, milkMorningL: 1, milkEveningL: 1, half: null, skip: false, note: '' };
    const out = entryChanges(base, { ...base, milkMorningL: 2, milkL: 3 });
    expect(out).toEqual({ milkL: 3, milkMorningL: 2, milkEveningL: 1, half: null, skip: false });
  });
  it('a note-only change still writes only the note', () => {
    const base = { milkL: 2, milkMorningL: 1, milkEveningL: 1, note: '' };
    expect(entryChanges(base, { ...base, note: 'late' })).toEqual({ note: 'late' });
  });
});

describe('#2 Delivery card follows a save from the other phone', () => {
  it('the open card reloads when the saved entry changes', () => {
    const T = todayISO();
    const fb = mkFb();
    const d1 = { [T]: { entries: { c1: { milkL: 2, milkMorningL: 2, milkEveningL: 0, half: 'morning', updatedAt: 1 } } } };
    const { rerender } = render(wrap(<Delivery {...props(fb, [twice], {}, d1)} />));
    expect(screen.getByTestId('qty-morning').querySelector('input').value).toBe('2');
    const d2 = { [T]: { entries: { c1: { milkL: 3, milkMorningL: 3, milkEveningL: 0, half: 'morning', updatedAt: 2 } } } };
    rerender(wrap(<Delivery {...props(fb, [twice], {}, d2)} />));
    expect(screen.getByTestId('qty-morning').querySelector('input').value).toBe('3');
  });
});

describe('#4 Register: Total / Skip close a morning-only day', () => {
  const T = () => todayISO();
  const half = () => ({ [T()]: { entries: { c1: { milkL: 1, milkMorningL: 1, milkEveningL: 0, half: 'morning', skip: false } } } });
  it('typed Total clears half', () => {
    const fb = mkFb();
    render(wrap(<DayEditor fb={fb} customers={[twice]} days={half()} settings={settings} displayName="x" date={T()} customerId="c1" lockDate onClose={() => {}} />));
    fireEvent.change(screen.getByTestId('day-editor').querySelector('input.qty'), { target: { value: '3' } });
    fireEvent.click(screen.getByText(en.save));
    expect(lastEntry(fb, 'c1')).toMatchObject({ milkL: 3, half: null });
  });
  it('Skip clears half', () => {
    const fb = mkFb();
    render(wrap(<DayEditor fb={fb} customers={[twice]} days={half()} settings={settings} displayName="x" date={T()} customerId="c1" lockDate onClose={() => {}} />));
    fireEvent.click(screen.getByText(en.skip));
    fireEvent.click(screen.getByText(en.save));
    expect(lastEntry(fb, 'c1')).toMatchObject({ skip: true, half: null });
  });
});

describe('#5 a recorded 0 L day is done', () => {
  it('dayComplete is true for 0 L (not half), false for paneer-only and morning-only', () => {
    expect(dayComplete({ milkL: 0, milkMorningL: 0, milkEveningL: 0, half: null }, twice)).toBe(true);
    expect(dayComplete({ milkL: 0, milkMorningL: 0, milkEveningL: 0, paneerKg: 0.2 }, twice)).toBe(false);
    expect(dayComplete({ milkL: 1, milkMorningL: 1, milkEveningL: 0, half: 'morning' }, twice)).toBe(false);
  });
  it('the other phone (no local skip) does not show the customer again', () => {
    const T = todayISO();
    const days = { [T]: { entries: { c1: { milkL: 0, milkMorningL: 0, milkEveningL: 0, half: null, skip: false } } } };
    render(wrap(<Delivery {...props(mkFb(), [twice, other], {}, days)} />));
    expect(document.querySelector('.deli-card h2').textContent).toContain('Bablu');
  });
});

describe('#6 the saved entry decides what is done', () => {
  it('a morning-only save arriving from the listener brings the customer back for the evening', () => {
    const T = todayISO();
    const fb = mkFb();
    const { rerender } = render(wrap(<Delivery {...props(fb, [twice], {}, {})} />));
    tap(screen.getByText(en.delivered));
    expect(screen.getByText(en.deliveryDone)).toBeTruthy(); // before the listener catches up
    const d = { [T]: { entries: { c1: { milkL: 1, milkMorningL: 1, milkEveningL: 0, half: 'morning', updatedAt: 5 } } } };
    rerender(wrap(<Delivery {...props(fb, [twice], {}, d)} />));
    expect(document.querySelector('.deli-card h2').textContent).toContain('Asha');
  });
});

describe('#7 Absent after Back keeps the saved morning', () => {
  it('split, after the morning time', () => {
    const T = todayISO();
    const fb = mkFb();
    const days = { [T]: { entries: { c1: { milkL: 2.5, milkMorningL: 1, milkEveningL: 1.5, half: null, skip: false } } } };
    render(wrap(<Delivery {...props(fb, [twice], { deliveryFormat: 'split', morningUntil: '00:00' }, days)} />));
    tap(screen.getByText('← ' + en.deliveryEditLast));
    tap(screen.getByText(en.absent));
    const e = lastEntry(fb, 'c1');
    expect(e.skip).toBeFalsy();
    expect(e).toMatchObject({ milkMorningL: 1, milkEveningL: 0, milkL: 1 });
  });
});

describe('#8 IST date and morning round, whatever the phone zone', () => {
  it('todayISO / roundFor use Asia/Kolkata', () => {
    expect(todayISO(new Date(Date.UTC(2026, 10, 6, 20, 0)))).toBe('2026-11-07'); // 01:30 IST
    expect(todayISO(new Date(Date.UTC(2026, 10, 6, 18, 29)))).toBe('2026-11-06'); // 23:59 IST
    expect(roundFor(new Date(Date.UTC(2026, 10, 6, 8, 29)), '14:00')).toBe('morning'); // 13:59 IST
    expect(roundFor(new Date(Date.UTC(2026, 10, 6, 8, 30)), '14:00')).toBe('day'); // 14:00 IST
  });
});

describe('#9 a tap just after midnight never writes to yesterday', () => {
  it('Delivered after midnight (before the 30 s tick) writes nothing for the old date', () => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 6, 18, 29, 50))); // 23:59:50 IST
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb, [twice], {}, {})} />));
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 6, 18, 30, 5))); // 00:00:05 IST next day
    fireEvent.click(screen.getByText(en.delivered));
    expect(dayWrites(fb).filter((w) => w.path.endsWith('2026-11-06'))).toEqual([]);
  });
});
