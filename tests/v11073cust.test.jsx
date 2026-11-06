// v1.10.73 customers + import review (check/customers.txt 1-9) and the shared rate-lock fix
// (money.txt #1, app.txt #4): rate saves wait for old history; the lock uses the live customer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
vi.mock('@capacitor/app', () => ({ App: { addListener: () => Promise.resolve({ remove: () => {} }), minimizeApp: async () => {} } }));
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
import { CustomerForm } from '../src/screens/Customers.jsx';
import ImportReview from '../src/screens/ImportReview.jsx';
import Settings from '../src/screens/Settings.jsx';
import { parseImportList } from '../src/importList.js';
import { maybeLockPaneer, paneerLockKey, resetPaneerLockForTests } from '../src/paneerLock.js';

const en = STRINGS.en;
const settings = { milkRatePaise: 6000, paneerRatePaise: 40000 };
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
function mkFb(commit = async () => {}) {
  const writes = [];
  const batches = [];
  const ref = (...parts) => ({ path: parts.filter((p) => typeof p === 'string').join('/'), id: parts[parts.length - 1] });
  return {
    writes,
    batches,
    farmId: 'f',
    db: {},
    auth: { currentUser: {} },
    authMod: { updateProfile: vi.fn(async () => {}) },
    fsMod: {
      doc: (...a) => (a.length === 1 ? { path: a[0].path + '/new', id: 'new' } : ref(...a.slice(1))),
      collection: (...a) => ref(...a.slice(1)),
      setDoc: vi.fn(async (r, data) => writes.push({ path: r.path, data })),
      updateDoc: vi.fn(async (r, data) => writes.push({ path: r.path, data, update: true })),
      deleteField: () => 'DEL',
      writeBatch: () => ({ update: (r, d) => batches.push([r.path, d]), set: () => {}, commit }),
      increment: (n) => n,
    },
  };
}
const dayWrites = (fb) => fb.writes.filter((w) => w.path.includes('/days/'));
const custWrites = (fb) => fb.writes.filter((w) => w.path.includes('/customers/'));
const c1 = { id: 'c1', name: 'Asha', usualL: 1, usualMorningL: 0.5, usualEveningL: 0.5, order: 10, active: true };

let errSpy;
beforeEach(() => {
  cleanup();
  localStorage.clear();
  fmt.today = null;
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  errSpy.mockRestore();
});

const form = (props) => wrap(<CustomerForm fb={props.fb} initial={props.initial ?? null} nextOrder={props.nextOrder ?? 90} settings={settings} days={props.days || {}} customers={props.customers || []} histOk={props.histOk} onDone={props.onDone || (() => {})} />);

describe('3: an old finished pause is not re-opened by a new Until', () => {
  it('old pause 1-5 Oct, Until changed to 10 Nov on 4 Nov -> refused', () => {
    fmt.today = '2026-11-04';
    const fb = mkFb();
    render(form({ fb, initial: { ...c1, pauseFrom: '2026-10-01', pauseTo: '2026-10-05' } }));
    fireEvent.change(screen.getByTestId('pause-to'), { target: { value: '2026-11-10' } });
    fireEvent.click(screen.getByText(en.save));
    expect(screen.getByText(en.pausePast)).toBeTruthy();
    expect(custWrites(fb)).toEqual([]);
    expect(screen.getByTestId('pause-from').getAttribute('min')).toBe('2026-11-04');
  });
  it('a pause still running keeps its old start when Until is extended', () => {
    fmt.today = '2026-11-04';
    const fb = mkFb();
    render(form({ fb, initial: { ...c1, pauseFrom: '2026-11-01', pauseTo: '2026-11-08' } }));
    expect(screen.getByTestId('pause-from').getAttribute('min')).toBe('2026-11-01');
    fireEvent.change(screen.getByTestId('pause-to'), { target: { value: '2026-11-12' } });
    fireEvent.click(screen.getByText(en.save));
    expect(custWrites(fb).at(-1).data).toMatchObject({ pauseTo: '2026-11-12' });
    expect('pauseFrom' in custWrites(fb).at(-1).data).toBe(false);
  });
});

describe('4: re-activated from the form goes to the end of the route', () => {
  it('tick Active + Save -> order = nextOrder', () => {
    const fb = mkFb();
    render(form({ fb, initial: { ...c1, active: false, order: 30 }, nextOrder: 120 }));
    fireEvent.click(screen.getByLabelText(en.active));
    fireEvent.click(screen.getByText(en.save));
    expect(custWrites(fb).at(-1).data).toMatchObject({ active: true, order: 120 });
  });
  it('a normal edit keeps the order', () => {
    const fb = mkFb();
    render(form({ fb, initial: c1, nextOrder: 120 }));
    fireEvent.change(screen.getByDisplayValue('Asha'), { target: { value: 'Asha D' } });
    fireEvent.click(screen.getByText(en.save));
    expect('order' in custWrites(fb).at(-1).data).toBe(false);
  });
});

describe('5 + rate lock: customer special rate', () => {
  const days = { '2026-10-03': { entries: { c1: { milkL: 1, milkRatePaise: null } } } };
  const openRates = () => fireEvent.click(screen.getByTestId('special-rates'));
  it('old history still loading: the rate change is refused, nothing written or frozen', () => {
    const fb = mkFb();
    render(form({ fb, initial: c1, days, customers: [c1], histOk: false }));
    openRates();
    fireEvent.click(screen.getByLabelText(en.customRateToggle));
    fireEvent.change(document.querySelector('.special-rates input[type="number"]'), { target: { value: '65' } });
    fireEvent.click(screen.getByText(en.save));
    expect(screen.getByText(en.rateWaitHistory)).toBeTruthy();
    expect(custWrites(fb)).toEqual([]);
    expect(fb.batches).toEqual([]);
  });
  it('history loading does not block a save without a rate change', () => {
    const fb = mkFb();
    render(form({ fb, initial: c1, days, customers: [c1], histOk: false }));
    fireEvent.change(screen.getByDisplayValue('Asha'), { target: { value: 'Asha D' } });
    fireEvent.click(screen.getByText(en.save));
    expect(custWrites(fb).at(-1).data).toMatchObject({ name: 'Asha D' });
  });
  it('the lock freezes at the LIVE customer rate (changed on another phone after the form opened)', () => {
    const fb = mkFb();
    const opened = { ...c1, rateOverridePaise: 6200 };
    const live = { ...c1, rateOverridePaise: 6400 };
    render(form({ fb, initial: opened, days, customers: [live], histOk: true }));
    fireEvent.change(document.querySelector('.special-rates input[type="number"]'), { target: { value: '70' } });
    fireEvent.click(screen.getByText(en.save));
    expect(fb.batches).toEqual([['farms/f/days/2026-10-03', { 'entries.c1.milkRatePaise': 6400 }]]);
    expect(custWrites(fb).at(-1).data).toMatchObject({ rateOverridePaise: 7000 });
  });
});

describe('7: Add customer warns about an existing name', () => {
  it('cancel -> nothing saved; OK -> saved', () => {
    const conf = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fb = mkFb();
    render(form({ fb, customers: [c1] }));
    fireEvent.change(document.querySelector('input'), { target: { value: '  asha ' } });
    fireEvent.click(screen.getByText(en.save));
    expect(conf).toHaveBeenCalledWith(en.dupCustomer);
    expect(custWrites(fb)).toEqual([]);
    conf.mockReturnValue(true);
    fireEvent.click(screen.getByText(en.save));
    expect(custWrites(fb).at(-1).data).toMatchObject({ name: 'asha', order: 90 });
  });
  it('a new name does not ask', () => {
    const conf = vi.spyOn(window, 'confirm');
    const fb = mkFb();
    render(form({ fb, customers: [c1] }));
    fireEvent.change(document.querySelector('input'), { target: { value: 'Ravi' } });
    fireEvent.click(screen.getByText(en.save));
    expect(conf).not.toHaveBeenCalled();
    expect(custWrites(fb).length).toBe(1);
  });
});

describe('8: a typed minus opening due is refused', () => {
  it('-500 with Due -> error, nothing saved', () => {
    const fb = mkFb();
    render(form({ fb, initial: c1 }));
    const due = [...document.querySelectorAll('input[type="number"]')].find((i) => i.closest('label')?.textContent.includes(en.openingDue));
    fireEvent.change(due, { target: { value: '-500' } });
    fireEvent.click(screen.getByText(en.save));
    expect(screen.getByText(en.amountInvalid)).toBeTruthy();
    expect(custWrites(fb)).toEqual([]);
  });
});

describe('6: import list, evening only', () => {
  it('"Sita,,1" is 0 morning + 1 evening; others unchanged', () => {
    expect(parseImportList('Sita,,1')).toEqual([{ name: 'Sita', morningL: 0, eveningL: 1 }]);
    expect(parseImportList('Ram,1')).toEqual([{ name: 'Ram', morningL: 1, eveningL: 0 }]);
    expect(parseImportList('Mohan')).toEqual([{ name: 'Mohan', morningL: 0.5, eveningL: 0.5 }]);
  });
});

describe('9 + key after writes: one-time paneer repair', () => {
  const customers = [{ id: 'a', name: 'A' }];
  const days = { '2026-10-02': { entries: { a: { paneerKg: 1, paneerRatePaise: null } } } };
  const ready = { loaded: { days: true, customers: true, settings: true }, daysLive: true, customersLive: true, settingsLive: true, histOk: true };
  beforeEach(() => resetPaneerLockForTests());
  it('done key is set only after the batch write resolves, and not re-run meanwhile', async () => {
    let resolve;
    const fb = mkFb(() => new Promise((r) => (resolve = r)));
    const r = maybeLockPaneer({ fb, ...ready, settings, customers, days });
    expect(r.state).toBe('ran');
    expect(localStorage.getItem(paneerLockKey(fb))).toBeNull();
    expect(maybeLockPaneer({ fb, ...ready, settings, customers, days }).state).toBe('running');
    expect(fb.batches.length).toBe(1);
    resolve();
    expect(await r.done).toBe(true);
    expect(localStorage.getItem(paneerLockKey(fb))).toBeTruthy();
    expect(maybeLockPaneer({ fb, ...ready, settings, customers, days }).state).toBe('done');
  });
  it('a failed write leaves it not done, so it runs again', async () => {
    const fb = mkFb(async () => {
      throw new Error('denied');
    });
    const r = maybeLockPaneer({ fb, ...ready, settings, customers, days });
    expect(await r.done).toBe(false);
    expect(localStorage.getItem(paneerLockKey(fb))).toBeNull();
    expect(maybeLockPaneer({ fb, ...ready, settings, customers, days }).state).toBe('ran');
  });
  it('per farm: done for farm A still runs for farm B', async () => {
    const a = mkFb();
    await maybeLockPaneer({ fb: a, ...ready, settings, customers, days }).done;
    const b = { ...mkFb(), farmId: 'g' };
    expect(maybeLockPaneer({ fb: a, ...ready, settings, customers, days }).state).toBe('done');
    expect(maybeLockPaneer({ fb: b, ...ready, settings, customers, days }).state).toBe('ran');
  });
});

describe('1 + 2: import review', () => {
  const twice = { ...c1, name: 'Asha' };
  const open = () => fireEvent.click(screen.getByText(/Asha/));
  const ui = (fb, days) => wrap(<ImportReview fb={fb} customers={[twice]} days={days} settings={settings} displayName="x" onDone={() => {}} />);
  it('a day changed on another phone after opening is not written back by Save all days', () => {
    fmt.today = '2026-10-02';
    const fb = mkFb();
    const d0 = { '2026-10-01': { entries: { c1: { milkL: 2, milkRatePaise: 6000 } } } };
    const { rerender } = render(ui(fb, d0));
    open();
    rerender(ui(fb, { '2026-10-01': { entries: { c1: { milkL: 3, milkRatePaise: 6000 } } } }));
    const inputs = document.querySelectorAll('.full-overlay input.qty');
    expect(inputs[0].value).toBe('3'); // untouched box follows the app
    fireEvent.change(inputs[1], { target: { value: '1' } });
    fireEvent.click(screen.getByText(en.saveAllDays));
    expect(dayWrites(fb).find((x) => x.path.endsWith('2026-10-01'))).toBeUndefined();
    expect(dayWrites(fb).find((x) => x.path.endsWith('2026-10-02')).data.entries.c1.milkL).toBe(1);
  });
  it('days still loading at open: the paper number does not overwrite the loaded day', () => {
    fmt.today = '2026-10-02';
    const fb = mkFb();
    const { rerender } = render(ui(fb, {}));
    open();
    expect(document.querySelectorAll('.full-overlay input.qty')[0].value).toBe('2'); // register value
    rerender(ui(fb, { '2026-10-01': { entries: { c1: { milkL: 1.5, milkRatePaise: 6000 } } } }));
    expect(document.querySelectorAll('.full-overlay input.qty')[0].value).toBe('1.5');
    fireEvent.click(screen.getByText(en.saveAllDays));
    expect(dayWrites(fb).find((x) => x.path.endsWith('2026-10-01'))).toBeUndefined();
    expect(dayWrites(fb).find((x) => x.path.endsWith('2026-10-02')).data.entries.c1.milkL).toBe(2); // empty day imported
  });
  it('a box the user changed is still saved', () => {
    fmt.today = '2026-10-02';
    const fb = mkFb();
    render(ui(fb, { '2026-10-01': { entries: { c1: { milkL: 2, milkRatePaise: 6000 } } } }));
    open();
    fireEvent.change(document.querySelectorAll('.full-overlay input.qty')[0], { target: { value: '2.5' } });
    fireEvent.click(screen.getByText(en.saveAllDays));
    expect(dayWrites(fb).find((x) => x.path.endsWith('2026-10-01')).data.entries.c1.milkL).toBe(2.5);
  });
  it('✕ on a day with paneer clears only the milk', () => {
    fmt.today = '2026-10-01';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fb = mkFb();
    render(ui(fb, { '2026-10-01': { entries: { c1: { milkL: 2, paneerKg: 0.5, paneerRatePaise: 40000, milkRatePaise: 6000 } } } }));
    open();
    fireEvent.click(screen.getByLabelText(en.delete));
    expect(fb.fsMod.updateDoc).not.toHaveBeenCalled();
    const e = dayWrites(fb).at(-1).data.entries.c1;
    expect(e).toMatchObject({ milkL: 0, milkMorningL: 0, milkEveningL: 0, milkRatePaise: null });
    expect('paneerKg' in e).toBe(false);
  });
  it('✕ on a milk-only day deletes it; typing again writes a full new entry', () => {
    fmt.today = '2026-10-01';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fb = mkFb();
    const days = { '2026-10-01': { entries: { c1: { milkL: 2, milkRatePaise: 6000, paneerKg: 0, note: '' } } } };
    render(ui(fb, days));
    open();
    fireEvent.click(screen.getByLabelText(en.delete));
    expect(fb.fsMod.updateDoc).toHaveBeenCalled();
    fireEvent.change(document.querySelectorAll('.full-overlay input.qty')[0], { target: { value: '2' } }); // listener lag: old entry still in days
    fireEvent.click(screen.getByText(en.saveAllDays));
    const e = dayWrites(fb).at(-1).data.entries.c1;
    expect(e.milkL).toBe(2);
    expect(e.milkRatePaise).toBe(6000); // a new entry with its rate snapshot (was skipped as "unchanged")
  });
});

describe('rate lock: Settings rate save waits for old history', () => {
  const base = { milkRatePaise: 6000, paneerRatePaise: 40000, farmName: 'X', phone: '1', upiId: '' };
  const S = (fb, histOk) => wrap(<Settings fb={fb} user={{ uid: 'u' }} settings={base} displayName="Bhai" setDisplayName={() => {}} online={false} farm={null} farmId="f" customers={[c1]} days={{ '2026-07-01': { entries: { c1: { milkL: 1 } } } }} histOk={histOk} />);
  const settingsWrites = (fb) => fb.writes.filter((x) => x.path === 'farms/f/settings/main').map((x) => x.data);
  it('histOk false: rate change refused with a message, no PIN/confirm, nothing written', async () => {
    const conf = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fb = mkFb();
    const { container } = render(S(fb, false));
    fireEvent.change(container.querySelectorAll('input[type="number"]')[0], { target: { value: '65' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(screen.getByText(en.rateWaitHistory)).toBeTruthy();
    expect(conf).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 30));
    expect(settingsWrites(fb)).toEqual([]);
    expect(fb.batches).toEqual([]);
  });
  it('histOk true: saved, old day frozen first', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fb = mkFb();
    const { container } = render(S(fb, true));
    fireEvent.change(container.querySelectorAll('input[type="number"]')[0], { target: { value: '65' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(settingsWrites(fb)).toEqual([{ milkRatePaise: 6500 }]));
    expect(fb.batches).toEqual([['farms/f/days/2026-07-01', { 'entries.c1.milkRatePaise': 6000 }]]);
  });
});
