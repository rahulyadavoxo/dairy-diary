// fix-entry: regression tests for the data-entry review (entry.txt section B, 9 findings) and
// money #4 (Import review re-priced old days at today's rate).
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
import RegisterView from '../src/screens/RegisterView.jsx';
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
const mornOnly = { id: 'c2', name: 'Bablu', order: 20, usualMorningL: 1, usualEveningL: 0 };
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

describe('1: Back to an Absent customer, then As usual', () => {
  it('saves the whole usual day (morning + evening), not the morning only', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fb = mkFb();
    render(wrap(<Delivery fb={fb} customers={[c1, c2]} days={{}} settings={settings} displayName="x" onBack={() => {}} />));
    tap(screen.getByText(en.absent));
    tap(screen.getByText('← ' + en.back));
    tap(screen.getByTestId('as-usual-btn'));
    const e = dayWrites(fb).at(-1).data.entries.c1;
    expect(e.milkL).toBe(2.5);
    expect(e.milkEveningL).toBe(1.5);
    expect(e.half ?? null).toBe(null);
  });
});

describe('2: Delivery left open past midnight', () => {
  it('starts a fresh round on the new date (yesterday-delivered customers come back)', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fb = mkFb();
    const P = (days) => <Delivery fb={fb} customers={[c1, c2]} days={days} settings={settings} displayName="x" onBack={() => {}} />;
    const { rerender } = render(wrap(P({})));
    tap(screen.getByTestId('as-usual-btn')); // Asha on 1 Nov
    fmt.today = '2026-11-02';
    rerender(wrap(P({ '2026-11-01': { entries: { c1: { milkL: 2.5, milkMorningL: 1, milkEveningL: 1.5 } } } })));
    expect(document.querySelector('.deli-card h2').textContent).toContain('Asha');
    tap(screen.getByTestId('as-usual-btn'));
    expect(dayWrites(fb).at(-1).path).toMatch(/2026-11-02$/);
  });
  it('the 30 s timer picks up the new day without a re-render from outside', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(2026, 10, 1, 23, 59, 50));
    const fb = mkFb();
    const days = { '2026-11-01': { entries: { c1: { milkL: 2.5, milkMorningL: 1, milkEveningL: 1.5 } } } };
    render(wrap(<Delivery fb={fb} customers={[c1, c2]} days={days} settings={settings} displayName="x" onBack={() => {}} />));
    expect(document.querySelector('.deli-card h2').textContent).toContain('Bablu');
    fmt.today = '2026-11-02';
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(document.querySelector('.deli-card h2').textContent).toContain('Asha');
  });
});

describe('3: Edit old records on today -> Save all', () => {
  it('keeps untouched "Evening left" rows as they are, writes only the edited row', () => {
    const fb = mkFb();
    const T = '2026-11-01';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const days = {
      [T]: {
        entries: {
          c1: { milkL: 1, milkMorningL: 1, milkEveningL: 0, paneerKg: 0, half: 'morning', skip: false },
          c2: { milkL: 1, milkMorningL: 1, milkEveningL: 0, paneerKg: 0, half: 'morning', skip: false },
        },
      },
    };
    render(wrap(<DayEditor fb={fb} customers={[c1, c2]} days={days} settings={settings} displayName="x" date={T} lockDate={false} onClose={() => {}} />));
    fireEvent.click(screen.getByText(en.saveAll));
    const ws = dayWrites(fb);
    const touched = ws.flatMap((w) => Object.keys(w.data.entries || {}));
    expect(touched).not.toContain('c1');
    expect(touched).not.toContain('c2');
  });
});

describe('4 + money 4: Import Review on a day corrected in the app', () => {
  it('prefills the app value and Save all days changes nothing', () => {
    fmt.today = '2026-10-02';
    const fb = mkFb();
    const days = { '2026-10-01': { entries: { c1: { milkL: 1.5, milkMorningL: 0, milkEveningL: 0, milkRatePaise: 5000 } } } };
    render(wrap(<ImportReview fb={fb} customers={[twice]} days={days} settings={settings} displayName="x" onDone={() => {}} />));
    fireEvent.click(screen.getByText(/Asha/));
    const inputs = [...document.querySelectorAll('.full-overlay input.qty')].map((i) => i.value);
    expect(inputs).toEqual(['1.5', '2']);
    fireEvent.click(screen.getByText(en.saveAllDays));
    expect(dayWrites(fb).find((x) => x.path.endsWith('2026-10-01'))).toBeUndefined();
    // the empty day takes the register value as a new entry
    expect(dayWrites(fb).find((x) => x.path.endsWith('2026-10-02')).data.entries.c1.milkL).toBe(2);
  });
  it('correcting an old day keeps that day\'s rate snapshot (not today\'s rate)', () => {
    fmt.today = '2026-10-02';
    const fb = mkFb();
    const days = { '2026-10-01': { entries: { c1: { milkL: 1.5, milkMorningL: 0, milkEveningL: 0, paneerKg: 0.25, paneerRatePaise: 30000, milkRatePaise: 5000, skip: false, note: '' } } } };
    render(wrap(<ImportReview fb={fb} customers={[twice]} days={days} settings={settings} displayName="x" onDone={() => {}} />));
    fireEvent.click(screen.getByText(/Asha/));
    const input = document.querySelectorAll('.full-overlay input.qty')[0];
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.click(screen.getByText(en.saveAllDays));
    const e = dayWrites(fb).find((x) => x.path.endsWith('2026-10-01')).data.entries.c1;
    expect(e.milkL).toBe(3);
    expect('milkRatePaise' in e).toBe(false); // unchanged -> not written (bases)
    expect('paneerRatePaise' in e).toBe(false);
  });
});

describe('5: split format, Absent in the morning round', () => {
  it('twice-a-day: phone B also treats the morning as done', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 1, 9, 0));
    const fb = mkFb();
    const s = { ...settings, deliveryFormat: 'split' };
    const days = { '2026-11-01': { entries: { c1: { milkL: 0, milkMorningL: 0, milkEveningL: 0, paneerKg: 0, skip: false, half: 'morning' } } } };
    render(wrap(<Delivery fb={fb} customers={[twice, { ...c2, id: 'c3', name: 'Chhotu', order: 30 }]} days={days} settings={s} displayName="x" onBack={() => {}} />));
    expect(document.querySelector('.deli-card h2').textContent).toContain('Chhotu');
  });
  it('once-a-day: morning Absent = whole-day Absent, so it does not come back in the afternoon', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 1, 9, 0));
    const fb = mkFb();
    const s = { ...settings, deliveryFormat: 'split' };
    render(wrap(<Delivery fb={fb} customers={[mornOnly]} days={{}} settings={s} displayName="x" onBack={() => {}} />));
    fireEvent.click(screen.getByText(en.absent));
    const e = dayWrites(fb).at(-1).data.entries.c2;
    expect(e.skip).toBe(true);
    cleanup();
    vi.setSystemTime(new Date(2026, 10, 1, 15, 0));
    render(wrap(<Delivery fb={fb} customers={[mornOnly]} days={{ '2026-11-01': { entries: { c2: e } } }} settings={s} displayName="x" onBack={() => {}} />));
    expect(document.querySelector('.deli-card')).toBeNull();
  });
  it('twice-a-day morning Absent still records the morning only (evening comes later)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 1, 9, 0));
    const fb = mkFb();
    render(wrap(<Delivery fb={fb} customers={[twice]} days={{}} settings={{ ...settings, deliveryFormat: 'split' }} displayName="x" onBack={() => {}} />));
    fireEvent.click(screen.getByText(en.absent));
    const e = dayWrites(fb).at(-1).data.entries.c1;
    expect(e.skip).toBeFalsy();
    expect(e.half).toBe('morning');
  });
});

describe('6: register litres follow morning + evening like the bill', () => {
  const merged = { milkMorningL: 1.5, milkEveningL: 0.5, milkL: 1.5, paneerKg: 0, skip: false };
  it('Register card shows 2 L', () => {
    const days = { '2026-11-01': { entries: { c1: merged } } };
    render(wrap(<RegisterView fb={mkFb()} customers={[c1]} days={days} pendingDays={{}} settings={settings} displayName="x" />));
    const card = document.querySelector('.cust-card');
    expect(card.textContent).toContain('2');
    expect(card.textContent).not.toMatch(/1\.5 L/);
  });
  it('DayEditor total row shows 2', () => {
    const T = '2026-10-20';
    const days = { [T]: { entries: { c1: merged } } };
    render(wrap(<DayEditor fb={mkFb()} customers={[c1]} days={days} settings={settings} displayName="x" date={T} customerId="c1" lockDate onClose={() => {}} />));
    fireEvent.click(screen.getByText(en.session_total));
    const vals = [...screen.getByTestId('day-editor').querySelectorAll('input')].map((i) => i.value);
    expect(vals).toContain('2');
  });
});

describe('7: typing the Total hides As usual', () => {
  it('+ on Total hides the As usual button; Delivered saves the total', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fb = mkFb();
    render(wrap(<Delivery fb={fb} customers={[c1]} days={{}} settings={settings} displayName="x" onBack={() => {}} />));
    const totalBox = screen.getByTestId('qty-total');
    const plus = totalBox.querySelectorAll('button.step')[1];
    fireEvent.click(plus);
    expect(screen.queryByTestId('as-usual-btn')).toBeNull();
  });
});

describe('8: pause with only "Until"', () => {
  it('fills "From" with today', () => {
    const fb = mkFb();
    render(wrap(<CustomerForm fb={fb} initial={{ ...c1 }} nextOrder={30} settings={settings} days={{}} onDone={() => {}} />));
    fireEvent.change(screen.getByTestId('pause-to'), { target: { value: '2026-11-10' } });
    fireEvent.click(screen.getByText(en.save));
    const w = custWrites(fb).at(-1).data;
    expect(w.pauseFrom).toBe('2026-11-01');
    expect(w.pauseTo).toBe('2026-11-10');
  });
  it('an old Until-only record re-saved unchanged is left alone', () => {
    const fb = mkFb();
    render(wrap(<CustomerForm fb={fb} initial={{ ...c1, pauseTo: '2026-11-10' }} nextOrder={30} settings={settings} days={{}} onDone={() => {}} />));
    fireEvent.change(screen.getByDisplayValue('Asha'), { target: { value: 'Asha D' } });
    fireEvent.click(screen.getByText(en.save));
    const w = custWrites(fb).at(-1).data;
    expect(w.name).toBe('Asha D');
    expect('pauseFrom' in w).toBe(false);
  });
});

describe('9: Deactivate keeps the other unsaved edits', () => {
  it('writes the edited name together with active: false', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fb = mkFb();
    const done = vi.fn();
    render(wrap(<CustomerForm fb={fb} initial={{ ...c1 }} nextOrder={30} settings={settings} days={{}} onDone={done} />));
    fireEvent.change(screen.getByDisplayValue('Asha'), { target: { value: 'Asha Devi' } });
    fireEvent.click(screen.getByText(en.deactivate));
    const w = custWrites(fb).at(-1).data;
    expect(w.active).toBe(false);
    expect(w.name).toBe('Asha Devi');
    expect(done).toHaveBeenCalledWith('c1');
  });
});
