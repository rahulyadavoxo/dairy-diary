// fix2-entry: regression tests for the entry re-check (N1-N4) after 1.10.59.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
vi.mock('../src/feedback.js', () => ({ playSound: () => {}, vibrateFail: () => {}, saveFeedback: (ok) => ok }));
vi.mock('../src/billCache.js', () => ({ getCachedPhoto: vi.fn(async () => null), putCachedPhoto: vi.fn(), deleteCachedPhoto: vi.fn() }));
vi.mock('../src/octoberImport.js', () => ({
  OCT_IMPORT: { '2026-10-01': { Asha: 2 }, '2026-10-02': { Asha: 2 } },
  IMPORT_DATES: ['2026-10-01', '2026-10-02'],
  parseImportValue: (v) => (v == null || v === 'X' ? null : { milkL: Number(v) }),
}));
const fmt = vi.hoisted(() => ({ today: null }));
vi.mock('../src/format.js', async (orig) => {
  const m = await orig();
  return { ...m, todayISO: () => fmt.today || m.todayISO() };
});
import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import Delivery, { TAP_GUARD_MS } from '../src/screens/Delivery.jsx';
import DayEditor from '../src/screens/Register.jsx';
import { entryComplete } from '../src/entry.js';
import ImportReview from '../src/screens/ImportReview.jsx';
import { CustomerForm } from '../src/screens/Customers.jsx';

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
      increment: (n) => n,
    },
  };
}
const dayWrites = (fb) => fb.writes.filter((w) => w.path.includes('/days/'));
const custWrites = (fb) => fb.writes.filter((w) => w.path.includes('/customers/'));
let now = 1_000_000;
const tap = (el) => {
  now += TAP_GUARD_MS + 1;
  fireEvent.click(el);
};
const c1 = { id: 'c1', name: 'Asha', order: 10, usualMorningL: 1, usualEveningL: 1.5 };
const c2 = { id: 'c2', name: 'Bablu', order: 20, usualMorningL: 1, usualEveningL: 1 };
const twice = { id: 'c1', name: 'Asha', order: 10, usualMorningL: 1, usualEveningL: 1 };

beforeEach(() => {
  cleanup();
  localStorage.clear();
  now = 1_000_000;
  fmt.today = '2026-11-01';
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fmt.today = null;
});


describe('N1: Edit old records -> Save all', () => {
  const halfDay = () => ({
    c1: { milkL: 1, milkMorningL: 1, milkEveningL: 0, paneerKg: 0, half: 'morning', skip: false },
    c2: { milkL: 1, milkMorningL: 1, milkEveningL: 0, paneerKg: 0, half: 'morning', skip: false },
  });
  it('a PAST day: closes the "Evening left" rows (evening 0) so the day is complete', () => {
    fmt.today = '2026-11-02';
    const fb = mkFb();
    const T = '2026-11-01';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(wrap(<DayEditor fb={fb} customers={[c1, c2]} days={{ [T]: { entries: halfDay() } }} settings={settings} displayName="x" date={T} lockDate={false} onClose={() => {}} />));
    fireEvent.click(screen.getByText(en.saveAll));
    const merged = {};
    dayWrites(fb).forEach((w) => Object.entries(w.data.entries || {}).forEach(([k, v]) => (merged[k] = { ...(merged[k] || {}), ...v })));
    for (const id of ['c1', 'c2']) {
      expect(merged[id]).toBeDefined();
      const after = { ...halfDay()[id], ...merged[id] };
      if (after.half === 'DEL') after.half = null;
      expect(after.half ?? null).toBe(null);
      expect(after.milkMorningL).toBe(1);
      expect(entryComplete(after, id === 'c1' ? c1 : c2)).toBe(true);
    }
  });
  it('a past split-morning Absent row (0 L, half) is closed too', () => {
    fmt.today = '2026-11-02';
    const fb = mkFb();
    const T = '2026-11-01';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const days = { [T]: { entries: { c1: { milkL: 0, milkMorningL: 0, milkEveningL: 0, paneerKg: 0, half: 'morning', skip: false } } } };
    render(wrap(<DayEditor fb={fb} customers={[c1]} days={days} settings={settings} displayName="x" date={T} lockDate={false} onClose={() => {}} />));
    fireEvent.click(screen.getByText(en.saveAll));
    expect(dayWrites(fb).flatMap((w) => Object.keys(w.data.entries || {}))).toContain('c1');
  });
  it('TODAY: untouched "Evening left" rows are still left open', () => {
    fmt.today = '2026-11-01';
    const fb = mkFb();
    const T = '2026-11-01';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(wrap(<DayEditor fb={fb} customers={[c1, c2]} days={{ [T]: { entries: halfDay() } }} settings={settings} displayName="x" date={T} lockDate={false} onClose={() => {}} />));
    fireEvent.click(screen.getByText(en.saveAll));
    expect(dayWrites(fb).flatMap((w) => Object.keys(w.data.entries || {}))).toEqual([]);
  });
  it('a past day with complete untouched rows writes nothing', () => {
    fmt.today = '2026-11-02';
    const fb = mkFb();
    const T = '2026-11-01';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const days = { [T]: { entries: { c1: { milkL: 2.5, milkMorningL: 1, milkEveningL: 1.5, paneerKg: 0, skip: false, milkRatePaise: 6000 } } } };
    render(wrap(<DayEditor fb={fb} customers={[c1]} days={days} settings={settings} displayName="x" date={T} lockDate={false} onClose={() => {}} />));
    fireEvent.click(screen.getByText(en.saveAll));
    expect(dayWrites(fb).flatMap((w) => Object.keys(w.data.entries || {}))).toEqual([]);
  });
});

describe('N2: split, "Same as last day" twice-a-day customer whose last evening was 0', () => {
  const lastDayC = { id: 'c1', name: 'Asha', order: 10, usualMorningL: 1, usualEveningL: 1, prefillMode: 'lastDay' };
  const yday = () => ({ '2026-11-01': { entries: { c1: { milkL: 1, milkMorningL: 1, milkEveningL: 0, paneerKg: 0, half: null, skip: false } } } });
  const s = { ...settings, deliveryFormat: 'split' };
  it('morning Absent records only the morning (no whole-day skip)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 2, 9, 0));
    fmt.today = '2026-11-02';
    const fb = mkFb();
    render(wrap(<Delivery fb={fb} customers={[lastDayC]} days={yday()} settings={s} displayName="x" onBack={() => {}} />));
    fireEvent.click(screen.getByText(en.absent));
    const e = dayWrites(fb).at(-1).data.entries.c1;
    expect(e.skip).toBeFalsy();
    expect(e.half).toBe('morning');
  });
  it('morning Delivered keeps the evening open, and the customer comes back for the evening', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 2, 9, 0));
    fmt.today = '2026-11-02';
    const fb = mkFb();
    render(wrap(<Delivery fb={fb} customers={[lastDayC]} days={yday()} settings={s} displayName="x" onBack={() => {}} />));
    fireEvent.click(screen.getByTestId('as-usual-btn'));
    const e = dayWrites(fb).at(-1).data.entries.c1;
    expect(e.milkMorningL).toBe(1);
    expect(e.half).toBe('morning');
    cleanup();
    vi.setSystemTime(new Date(2026, 10, 2, 17, 0));
    const days = { ...yday(), '2026-11-02': { entries: { c1: e } } };
    render(wrap(<Delivery fb={fb} customers={[lastDayC]} days={days} settings={s} displayName="x" onBack={() => {}} />));
    expect(document.querySelector('.deli-card h2').textContent).toContain('Asha');
  });
});

describe('N3: Import Review, an Absent / 0 L day in the app', () => {
  it('Absent day: prefill is empty and Save all days does not write the register value', () => {
    fmt.today = '2026-10-02';
    const fb = mkFb();
    const days = {
      '2026-10-01': { entries: { c1: { milkL: 0, milkMorningL: 0, milkEveningL: 0, paneerKg: 0, skip: true } } },
      '2026-10-02': { entries: { c1: { milkL: 0, milkMorningL: 0, milkEveningL: 0, paneerKg: 0, skip: false } } },
    };
    render(wrap(<ImportReview fb={fb} customers={[twice]} days={days} settings={settings} displayName="x" onDone={() => {}} />));
    fireEvent.click(screen.getByText(/Asha/));
    const inputs = [...document.querySelectorAll('.full-overlay input.qty')].map((i) => i.value);
    expect(inputs).toEqual(['', '']);
    fireEvent.click(screen.getByText(en.saveAllDays));
    expect(dayWrites(fb)).toEqual([]);
  });
  it('an empty morning-only placeholder still takes the register value', () => {
    fmt.today = '2026-10-01';
    const fb = mkFb();
    const days = { '2026-10-01': { entries: { c1: { milkL: 0, milkMorningL: 0, milkEveningL: 0, paneerKg: 0, skip: false, half: 'morning' } } } };
    render(wrap(<ImportReview fb={fb} customers={[twice]} days={days} settings={settings} displayName="x" onDone={() => {}} />));
    fireEvent.click(screen.getByText(/Asha/));
    expect(document.querySelectorAll('.full-overlay input.qty')[0].value).toBe('2');
  });
});

describe('N4: clearing only "From" of an existing pause', () => {
  it('fills From with today instead of saving Until-only', () => {
    fmt.today = '2026-11-02';
    const fb = mkFb();
    render(wrap(<CustomerForm fb={fb} initial={{ ...c1, pauseFrom: '2026-11-05', pauseTo: '2026-11-10' }} nextOrder={30} settings={settings} days={{}} onDone={() => {}} />));
    fireEvent.change(screen.getByTestId('pause-from'), { target: { value: '' } });
    fireEvent.click(screen.getByText(en.save));
    const w = custWrites(fb).at(-1).data;
    expect(w.pauseFrom).toBe('2026-11-02');
  });
  it('an old Until-only record re-saved unchanged is still left alone', () => {
    const fb = mkFb();
    render(wrap(<CustomerForm fb={fb} initial={{ ...c1, pauseTo: '2026-11-10' }} nextOrder={30} settings={settings} days={{}} onDone={() => {}} />));
    fireEvent.change(screen.getByDisplayValue('Asha'), { target: { value: 'Asha D' } });
    fireEvent.click(screen.getByText(en.save));
    expect('pauseFrom' in custWrites(fb).at(-1).data).toBe(false);
  });
});
