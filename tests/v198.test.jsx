import { dmy } from '../src/format.js';
// Regression tests for the 1.9.8 UI-audit fixes (one block per audit item that has logic).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent, cleanup, act, within, waitFor } from '@testing-library/react';

// Bill photo rendering needs a real canvas; sharing needs the system share sheet.
const share = vi.hoisted(() => ({ impl: null }));
vi.mock('../src/billImage.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    renderBillImage: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
    shareImage: vi.fn((...a) => share.impl(...a)),
  };
});
vi.mock('../src/billPreGen.js', () => ({ preGenerateBillPhotos: vi.fn() }));
// Mock the native WhatsApp plugin (1.9.9: photo only, no wa.me text fallback)
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({ shareImage: (...a) => share.impl(...a) }),
}));

import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { entryCharge, computeMonth, milkRateFor, paneerRateFor } from '../src/billing.js';
import { normaliseEntry } from '../src/entry.js';
import { todayISO, addDays, weekdaysMonFirst, shortDate, mondayOffset } from '../src/format.js';
import Delivery, { deliveredFor, deliveryList, TAP_GUARD_MS } from '../src/screens/Delivery.jsx';
import CustomerDetail, { isShareCancel } from '../src/screens/CustomerDetail.jsx';
import Customers, { CustomerForm, pauseLabel } from '../src/screens/Customers.jsx';
import Settings from '../src/screens/Settings.jsx';
import { hashPin, savePinHash } from '../src/pinLock.js';
import SetupFarm from '../src/screens/SetupFarm.jsx';
import Hisaab from '../src/screens/Hisaab.jsx';
import BillPhotos, { defaultPhotoMonth } from '../src/screens/BillPhotos.jsx';
import BillSender from '../src/screens/BillSender.jsx';
import RegisterView, { isRecordedGap } from '../src/screens/RegisterView.jsx';
import { matchesQuery } from '../src/screens/Register.jsx';
import DevicesCard from '../src/components/DevicesCard.jsx';
import { parseImportList, freshImports, DEFAULT_IMPORT_LIST } from '../src/importList.js';
import { fitText, billHeight } from '../src/billImage.js';
import { withFarmName } from '../src/App.jsx';
import { signOutAndWipe } from '../src/devices.js';
import { handleBack } from '../src/backStack.js';

const en = STRINGS.en;
const settings = { milkRatePaise: 6000, paneerRatePaise: 40000 };
const wrap = (ui, lang = 'en') => <LangContext.Provider value={{ lang, t: makeT(lang), setLang: () => {} }}>{ui}</LangContext.Provider>;

/** In-memory stand-in for the Firestore module: records every write, never touches the network. */
function mkFb() {
  const writes = [];
  const ref = (...parts) => ({ path: parts.filter((p) => typeof p === 'string').join('/'), id: parts[parts.length - 1] });
  return {
    writes,
    farmId: 'f',
    db: {},
    auth: { currentUser: { uid: 'u1' } },
    authMod: { updateProfile: vi.fn(async () => {}), signOut: vi.fn(async () => {}) },
    fsMod: {
      doc: (...a) => (a.length === 1 ? { path: a[0].path + '/new', id: 'new' } : ref(...a.slice(1))),
      collection: (...a) => ref(...a.slice(1)),
      setDoc: vi.fn(async (r, data) => {
        writes.push({ path: r.path, data });
      }),
      updateDoc: vi.fn(async (r, data) => {
        writes.push({ path: r.path, data, update: true });
      }),
      deleteField: () => 'DEL',
      serverTimestamp: () => 'TS',
      terminate: vi.fn(async () => {}),
      clearIndexedDbPersistence: vi.fn(async () => {}),
    },
  };
}
const dayWrites = (fb) => fb.writes.filter((w) => w.path.startsWith('farms/f/days/'));

beforeEach(() => {
  cleanup();
  localStorage.clear();
  share.impl = async () => 'shared';
});
afterEach(() => vi.restoreAllMocks());

// ---- 1 ----
describe('#1 entries saved before a rate was set are not billed ₹0', () => {
  it('a 0 / invalid snapshot falls back to the customer rate, then the settings rate', () => {
    expect(entryCharge({ milkL: 2, milkRatePaise: 0 }, {}, settings).milkPaise).toBe(12000);
    expect(entryCharge({ milkL: 2, milkRatePaise: 0 }, { rateOverridePaise: 7000 }, settings).milkPaise).toBe(14000);
    expect(entryCharge({ milkL: 2, milkRatePaise: null }, {}, settings).milkPaise).toBe(12000);
    expect(entryCharge({ milkL: 2, milkRatePaise: 5000 }, {}, settings).milkPaise).toBe(10000); // real snapshot kept
    expect(milkRateFor({}, settings, { milkRatePaise: -5 })).toBe(6000);
    expect(paneerRateFor(settings, { paneerRatePaise: 0 })).toBe(40000);
    expect(milkRateFor({}, { milkRatePaise: 0 }, null)).toBe(0);
  });
  it('the audit repro: 13 L of which one day was stored with rate 0 bills all 13 L', () => {
    const days = { '2026-10-01': { entries: { s: { milkL: 1, milkRatePaise: 0 } } } };
    for (let d = 2; d <= 13; d++) days[`2026-10-${String(d).padStart(2, '0')}`] = { entries: { s: { milkL: 1, milkRatePaise: 6000 } } };
    const r = computeMonth({ customers: [{ id: 's' }], days, settings: { milkRatePaise: 6000 }, month: '2026-10' }).rows[0];
    expect(r.milkMl).toBe(13000);
    expect(r.milkPaise).toBe(78000);
  });
  it('new entries store the rate only when it is > 0', () => {
    expect(normaliseEntry({}, { milkL: 1 }, {}).milkRatePaise).toBe(null);
    expect(normaliseEntry({}, { milkL: 1 }, {}).paneerRatePaise).toBe(null);
    expect(normaliseEntry({}, { milkL: 1 }, settings).milkRatePaise).toBe(6000);
    expect(normaliseEntry({ rateOverridePaise: 7000 }, { milkL: 1 }, settings).milkRatePaise).toBe(7000);
  });
});

// ---- 2 / 17 ----
describe('#2 payments with paise, #17 no future payment date', () => {
  const props = (fb, extra = {}) => ({
    fb, days: {}, payments: [], settings, displayName: 'x', customerId: 'c1', month: todayISO().slice(0, 7),
    setMonth: () => {}, onBack: () => {}, customers: [{ id: 'c1', name: 'Ram', openingDuePaise: 66050 }], ...extra,
  });
  const payWrites = (fb) => fb.writes.filter((w) => w.path.startsWith('farms/f/payments'));
  it('accepts ₹660.50 and the "Full" chip settles a paise balance exactly', () => {
    const fb = mkFb();
    render(wrap(<CustomerDetail {...props(fb)} />));
    const amount = screen.getByLabelText(en.amount);
    expect(amount.getAttribute('step')).toBe('any');
    fireEvent.click(screen.getByText(/^Full/));
    expect(amount.value).toBe('660.5');
    fireEvent.click(screen.getByText(en.addPayment));
    expect(payWrites(fb)).toHaveLength(1);
    expect(payWrites(fb)[0].data.amountPaise).toBe(66050);
  });
  it('rejects a future date', () => {
    const fb = mkFb();
    const { container } = render(wrap(<CustomerDetail {...props(fb)} />));
    const date = container.querySelector('.pay input[type="date"]');
    expect(date.getAttribute('max')).toBe(todayISO());
    fireEvent.change(date, { target: { value: addDays(todayISO(), 30) } });
    fireEvent.change(screen.getByLabelText(en.amount), { target: { value: '100' } });
    fireEvent.click(screen.getByText(en.addPayment));
    expect(payWrites(fb)).toHaveLength(0);
    expect(screen.getByText(en.dateFuture)).toBeTruthy();
  });
  it('every money input allows paise', () => {
    const src = ['Settings', 'Customers', 'CustomerDetail'].map((f) => readFileSync(`src/screens/${f}.jsx`, 'utf8')).join('\n');
    const money = src.match(/<input[^>]*value=\{(f\.milkRate|f\.paneerRate|f\.rateOverride|f\.openingDue|amount)\}[^>]*>/g);
    expect(money).toHaveLength(5);
    money.forEach((tag) => expect(tag).toContain('step="any"'));
  });
});

// ---- 3 / 4 / 15 / 16 ----
const c1 = { id: 'c1', name: 'Asha', order: 10, usualMorningL: 1, usualEveningL: 1 };
const c2 = { id: 'c2', name: 'Bablu', order: 20, usualMorningL: 1, usualEveningL: 0 };
const c3 = { id: 'c3', name: 'Chandan', order: 30, usualMorningL: 0.5, usualEveningL: 0.5 };
const sup = { id: 's1', name: 'Supplier Sharma', order: 40, usualMorningL: 20, usualEveningL: 0, isSupplier: true, phone: '9999999999' };
const deliProps = (fb, extra = {}) => ({ fb, customers: [sup, c1, c2, c3], days: {}, settings, displayName: 'x', onBack: () => {}, ...extra });
const setRound = (s) =>
  localStorage.setItem('dd_deli_session', JSON.stringify({ s, slot: `${todayISO()}-${new Date().getHours() < 13 ? 'morning' : 'evening'}` }));

describe('#3 double tap on Delivered marks only one customer', () => {
  it('a second tap within the guard time is ignored', () => {
    setRound('total');
    const fb = mkFb();
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    render(wrap(<Delivery {...deliProps(fb)} />));
    expect(screen.getByText('Asha')).toBeTruthy();
    fireEvent.click(screen.getByText(en.delivered));
    fireEvent.click(screen.getByText(en.delivered)); // lands on the next card
    expect(dayWrites(fb)).toHaveLength(1);
    expect(Object.keys(dayWrites(fb)[0].data.entries)).toEqual(['c1']);
    expect(screen.getByText('Bablu')).toBeTruthy();
    now += TAP_GUARD_MS + 1;
    fireEvent.click(screen.getByText(en.delivered));
    expect(dayWrites(fb)).toHaveLength(2);
  });
});

describe('#4 morning and evening are separate rounds', () => {
  it('deliveredFor is per session; a total-only entry covers both', () => {
    expect(deliveredFor({ milkL: 1, milkMorningL: 1, milkEveningL: 0 }, 'morning')).toBe(true);
    expect(deliveredFor({ milkL: 1, milkMorningL: 1, milkEveningL: 0 }, 'evening')).toBe(false);
    expect(deliveredFor({ milkL: 2, milkMorningL: 0, milkEveningL: 0 }, 'evening')).toBe(true);
    expect(deliveredFor({ milkL: 2, skip: true }, 'total')).toBe(false);
  });
  it('one card for the day keeps an earlier morning entry editable and saves both rounds', () => {
    const fb = mkFb();
    const days = { [todayISO()]: { entries: { c2: { milkL: 1, milkMorningL: 1, milkEveningL: 0 } } } };
    render(wrap(<Delivery {...deliProps(fb, { days })} />));
    expect(screen.getByText('Asha')).toBeTruthy();
    fireEvent.click(screen.getByText(en.asUsual, { selector: 'button' }));
    // 1.10.31: the evening box is filled with the usual, so As usual saves the whole usual day
    const e = dayWrites(fb)[0].data.entries.c1;
    expect([e.milkMorningL, e.milkL]).toEqual([1, 2]);
    expect(e.half).toBeFalsy();
  });
  it('"Everyone\'s usual" is a toggle: on writes both rounds, off puts things back', () => {
    const fb = mkFb();
    const days = { [todayISO()]: { entries: {} } };
    render(wrap(<Delivery {...deliProps(fb, { days })} />));
    const tog = screen.getByTestId('all-usual-toggle');
    expect(tog.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(tog);
    const entries = dayWrites(fb)[0].data.entries;
    expect(Object.keys(entries).sort()).toEqual(['c1', 'c2', 'c3', 's1']);
    expect(entries.c1.milkL).toBe(2);
    expect(screen.getByTestId('all-usual-toggle').getAttribute('aria-checked')).toBe('true');
    vi.spyOn(Date, 'now').mockImplementation(() => 99_999_999_999_999);
    fireEvent.click(screen.getByTestId('all-usual-toggle'));
    const dels = fb.writes.filter((w) => w.update);
    expect(dels.map((w) => Object.keys(w.data).find((k) => k.startsWith('entries.'))).sort()).toEqual(['entries.c1', 'entries.c2', 'entries.c3', 'entries.s1']);
    expect(screen.getByText('Asha')).toBeTruthy();
  });
});

describe('#15 Back / review keeps the history', () => {
  it('cancelling a review with the hardware back button does not lose that customer', () => {
    setRound('total');
    const fb = mkFb();
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const tap = (txt) => {
      now += 1000;
      fireEvent.click(screen.getByText(txt));
    };
    render(wrap(<Delivery {...deliProps(fb)} />));
    tap(en.delivered); // Asha
    tap(en.delivered); // Bablu
    const cardBack = () => screen.getAllByText(`← ${en.back}`).find((b) => b.closest('.deli-card'));
    now += 1000;
    fireEvent.click(cardBack());
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Bablu');
    act(() => {
      handleBack();
    });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Chandan');
    now += 1000;
    fireEvent.click(screen.getAllByText(`← ${en.back}`).find((b) => b.closest('.deli-card')));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Bablu'); // still there
    now += 1000;
    fireEvent.click(screen.getAllByText(`← ${en.back}`).find((b) => b.closest('.deli-card')));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Asha'); // and one further back
  });
});

describe('#16 Absent; empty list says so', () => {
  it('Absent writes "didn\'t take" for the day and moves on; it stays done after re-opening', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...deliProps(fb)} />));
    fireEvent.click(screen.getByText(en.absent));
    const e = dayWrites(fb)[0].data.entries.c1;
    expect([e.skip, e.milkL ?? 0]).toEqual([true, 0]);
    expect(screen.getByText('Bablu')).toBeTruthy();
  });
  it('paneer is a toggle on top, off by default; morning, evening and total below', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...deliProps(fb)} />));
    expect(screen.getByTestId('paneer-toggle').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('deli-total').textContent).toContain('2');
    fireEvent.click(screen.getByTestId('paneer-toggle'));
    expect(screen.getByTestId('paneer-toggle').getAttribute('aria-checked')).toBe('true');
    const btns = [...document.querySelectorAll('.deli-card .form-actions')[0].querySelectorAll('button')].map((b) => b.textContent);
    expect(btns).toEqual([en.asUsual, en.delivered]);
  });
  it('a customer marked "didn\'t take" for the day in the register is not on the round', () => {
    const days = { [todayISO()]: { entries: { c1: { milkL: 0, skip: true } } } };
    render(wrap(<Delivery {...deliProps(mkFb(), { days })} />));
    expect(screen.queryByText('Asha')).toBeNull();
    expect(screen.getByText('Bablu')).toBeTruthy();
  });
  it('no customers -> "no customers", not "All delivered"', () => {
    render(wrap(<Delivery {...deliProps(mkFb(), { customers: [] })} />));
    expect(screen.getByText(en.noCustomers)).toBeTruthy();
    expect(screen.queryByText(en.deliveryDone)).toBeNull();
  });
});

// ---- 5 ----
describe('#5 any past day can be edited from Register', () => {
  // a delivery 40 days ago, so the ◀ arrows (which stop at the first delivery month) can go back
  const oldDays = () => ({ [addDays(todayISO(), -40)]: { entries: { c1: { milkL: 1 } } } });
  const regProps = (fb, extra = {}) => ({ fb, customers: [c1, c2], days: oldDays(), pendingDays: {}, settings, displayName: 'x', onDelivery: () => {}, ...extra });
  it('"Edit this day" opens the editor for that date and saves through saveEntries', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fb = mkFb();
    const y = addDays(todayISO(), -1);
    // 1.10.14: "Edit this day" opens only once every customer has that day's entry
    render(wrap(<RegisterView {...regProps(fb, { days: { ...oldDays(), [y]: { entries: { c1: { milkL: 2 }, c2: { milkL: 1 } } } } })} />));
    fireEvent.click(screen.getByLabelText(en.prevDay));
    fireEvent.click(screen.getByText(new RegExp(en.editDay)));
    const ed = screen.getByTestId('day-editor');
    // mark Asha skipped and add a note for Bablu, then save
    fireEvent.click(within(ed).getAllByText(en.skip)[0]);
    vi.spyOn(window, 'prompt').mockReturnValue('late');
    fireEvent.click(within(ed).getAllByLabelText(en.note)[1]);
    fireEvent.click(within(ed).getByText(en.saveAll));
    const w = dayWrites(fb);
    expect(w.length).toBeGreaterThan(0);
    expect(w[w.length - 1].path).toBe(`farms/f/days/${y}`);
    const entries = Object.assign({}, ...w.map((x) => x.data.entries));
    expect(entries.c1.skip).toBe(true);
    expect(entries.c2.note).toBe('late');
  });
  it('a calendar date opens the editor for that customer only; hardware back closes it', () => {
    const fb = mkFb();
    render(wrap(<RegisterView {...regProps(fb)} />));
    fireEvent.click(screen.getByText(/Asha/));
    const y = addDays(todayISO(), -1);
    const [yy, mm, dd] = y.split('-');
    if (y.slice(0, 7) !== todayISO().slice(0, 7)) fireEvent.click(screen.getByText('◀', { selector: '.cal-nav button' }));
    // 1.10.13: dates open the editor only with the Edit switch ON (starts OFF)
    fireEvent.click(screen.getByLabelText(dmy(y)));
    expect(screen.queryByTestId('day-editor')).toBeNull();
    const sw = screen.getByRole('switch', { name: en.calEditToggle });
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    fireEvent.click(screen.getByLabelText(dmy(y)));
    const ed = screen.getByTestId('day-editor');
    expect(within(ed).getByRole('heading', { level: 1 }).textContent).toContain('Asha');
    expect(within(ed).queryByText(/Bablu/)).toBeNull();
    act(() => {
      handleBack();
    });
    expect(screen.queryByTestId('day-editor')).toBeNull();
  });
  it('1.10.24: today is never edited from the calendar; a wrong entry today can only be removed', () => {
    const fb = mkFb();
    const T = todayISO();
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const conf = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { unmount } = render(wrap(<RegisterView {...regProps(fb, { days: { ...oldDays(), [T]: { entries: { c1: { milkL: 0, skip: true } } } } })} />));
    fireEvent.click(screen.getByText(/Asha/));
    fireEvent.click(screen.getByRole('switch', { name: en.calEditToggle }));
    fireEvent.click(screen.getByLabelText(dmy(T), { selector: 'button.cal-cell' }));
    expect(screen.queryByTestId('day-editor')).toBeNull();
    expect(conf).toHaveBeenCalled();
    const w = fb.writes.at(-1);
    expect(w.update && w.data['entries.c1']).toBe('DEL');
    unmount();
    // no entry today -> only a hint, nothing written, no editor
    const fb2 = mkFb();
    render(wrap(<RegisterView {...regProps(fb2)} />));
    fireEvent.click(screen.getByText(/Asha/));
    fireEvent.click(screen.getByRole('switch', { name: en.calEditToggle }));
    fireEvent.click(screen.getByLabelText(dmy(T), { selector: 'button.cal-cell' }));
    expect(alert).toHaveBeenCalledWith(en.calTodayNoEdit);
    expect(screen.queryByTestId('day-editor')).toBeNull();
    expect(fb2.writes.length).toBe(0);
  });
  it('future dates in the calendar are not editable', () => {
    render(wrap(<RegisterView {...regProps(mkFb())} />));
    fireEvent.click(screen.getByText(/Asha/));
    const t = addDays(todayISO(), 1);
    if (t.slice(0, 7) === todayISO().slice(0, 7)) {
      const [yy, mm, dd] = t.split('-');
      expect(screen.getByLabelText(dmy(t)).disabled).toBe(true);
    }
  });
});

// ---- 6 ----
describe('#6 suppliers stay out of customer flows', () => {
  it('in the delivery round, in route order (1.10.5)', () => {
    expect(deliveryList([sup, c1], {}, todayISO(), 'total').map((c) => c.id)).toEqual(['c1', 's1']);
    expect(deliveryList([{ ...sup, order: 5 }, c1], {}, todayISO(), 'total').map((c) => c.id)).toEqual(['s1', 'c1']);
  });
  it('not in the Register day total', () => {
    const days = { [todayISO()]: { entries: { s1: { milkL: 20 }, c1: { milkL: 2 } } } };
    render(wrap(<RegisterView fb={mkFb()} customers={[sup, c1]} days={days} pendingDays={{}} settings={settings} displayName="x" />));
    expect(screen.getByText(/Day total/).textContent).toContain('2 L');
  });
  it('not in WhatsApp bills or bill photos; listed separately in Hisaab with "We owe"', () => {
    const bm = new Date();
    bm.setDate(1);
    bm.setMonth(bm.getMonth() - 1);
    const prev = `${bm.getFullYear()}-${String(bm.getMonth() + 1).padStart(2, '0')}`;
    const days = { [`${prev}-05`]: { entries: { s1: { milkL: 20 } } } };
    render(wrap(<BillSender fb={mkFb()} customers={[sup]} days={days} payments={[]} settings={settings} onClose={() => {}} />));
    expect(screen.getByText(en.noActivity)).toBeTruthy();
    cleanup();
    render(wrap(<BillPhotos customers={[sup]} days={days} payments={[]} settings={settings} month={prev} onClose={() => {}} />));
    expect(screen.getByText(`${en.makeBillPhotos} (0)`)).toBeTruthy();
    cleanup();
    render(wrap(<Hisaab fb={mkFb()} customers={[sup, c1]} days={days} payments={[]} settings={settings} month={prev} setMonth={() => {}} openCustomer={() => {}} />));
    const sRows = screen.getByTestId('supplier-rows');
    expect(within(sRows).getByText(/Supplier Sharma/)).toBeTruthy();
    expect(within(sRows).getByText(en.weOwe)).toBeTruthy();
    expect(screen.getAllByText(/Supplier Sharma/)).toHaveLength(1);
  });
});

// ---- 7 ----
describe('#7 closing the share sheet does not open WhatsApp', () => {
  const props = { days: {}, payments: [], settings, displayName: 'x', customerId: 'c1', month: '2026-10', setMonth: () => {}, onBack: () => {}, customers: [{ id: 'c1', name: 'Ram', phone: '9999999999' }] };
  it('AbortError is a cancel', async () => {
    share.impl = async () => {
      throw new DOMException('Share canceled', 'AbortError');
    };
    render(wrap(<CustomerDetail fb={mkFb()} {...props} />));
    await act(async () => {
      fireEvent.click(screen.getByText(en.shareWhatsApp));
    });
    expect(isShareCancel({ name: 'AbortError' })).toBe(true);
  });
  it('a real failure shows the shareFailed error (1.9.9: photo only, no text fallback)', async () => {
    share.impl = async () => {
      throw new Error('boom');
    };
    render(wrap(<CustomerDetail fb={mkFb()} {...props} />));
    await act(async () => {
      fireEvent.click(screen.getByText(en.shareWhatsApp));
    });
    expect(await screen.findByText('Share failed, try again')).toBeTruthy();
  });
});

// ---- 8 ----
describe('#8 dairy name from setup reaches settings and bills', () => {
  it('SetupFarm saves farmName into settings/main', async () => {
    const fb = mkFb();
    delete fb.farmId;
    render(wrap(<SetupFarm fb={fb} user={{ uid: 'u1', email: 'o@x.in' }} />));
    fireEvent.change(screen.getByLabelText(en.deviceName), { target: { value: 'Papa' } });
    fireEvent.change(screen.getByLabelText(en.farmName), { target: { value: ' Yadav Dairy ' } });
    await act(async () => {
      fireEvent.click(screen.getByText(en.setupButton));
    });
    const s = fb.writes.find((w) => w.path === 'farms/u1/settings/main');
    expect(s && s.data).toEqual({ farmName: 'Yadav Dairy' });
  });
  it('older farms: the farm-doc name is used until Settings has one', () => {
    expect(withFarmName({}, { name: 'Yadav Dairy' }).farmName).toBe('Yadav Dairy');
    expect(withFarmName({ farmName: 'X' }, { name: 'Y' }).farmName).toBe('X');
    const s = { milkRatePaise: 1 };
    expect(withFarmName(s, null)).toBe(s);
  });
});

// ---- 9 ----
describe('#9 no customer names in tracked source', () => {
  it('importList.js has no hard-coded list; the default comes from the optional local file', () => {
    const src = readFileSync('src/importList.js', 'utf8');
    expect(src).toContain("import.meta.glob('./importList.local.js'");
    expect(src).not.toMatch(/^export const DEFAULT_IMPORT_LIST\s*=\s*`/m);
    expect(src.split('\n').length).toBeLessThan(60);
    expect(typeof DEFAULT_IMPORT_LIST).toBe('string');
    expect(readFileSync('.gitignore', 'utf8')).toContain('src/*.local.js');
  });
});

// ---- 10 ----
describe('#10 hardware back closes sub-screens', () => {
  it('customer form', () => {
    render(wrap(<Customers fb={mkFb()} customers={[c1]} settings={settings} openCustomer={() => {}} />));
    fireEvent.click(screen.getByText(`+ ${en.addCustomer}`));
    expect(screen.getByText(en.save)).toBeTruthy();
    act(() => {
      expect(handleBack()).toBe(true);
    });
    expect(screen.getByText(`+ ${en.addCustomer}`)).toBeTruthy();
  });
  it('bill sender (Hisaab)', () => {
    render(wrap(<Hisaab fb={mkFb()} customers={[c1]} days={{}} payments={[]} settings={settings} month={todayISO().slice(0, 7)} setMonth={() => {}} openCustomer={() => {}} />));
    fireEvent.click(screen.getByLabelText(en.waBillsShort));
    expect(screen.queryByText(en.hisaabTitle)).toBeNull();
    act(() => {
      expect(handleBack()).toBe(true);
    });
    expect(screen.getByText(en.hisaabTitle)).toBeTruthy();
  });
});

// ---- 11 / 29 / 31 ----
describe('#11 Hindi strings are Devanagari; #31 dead keys removed', () => {
  it('no romanized Hinglish left in Hindi mode', () => {
    const latinOk = new Set(['langToggle', 'upi']);
    for (const [k, v] of Object.entries(STRINGS.hi)) if (!latinOk.has(k)) expect([k, /[\u0900-\u097F]/.test(v)]).toEqual([k, true]);
  });
  it('calendar weekdays and week-strip dates follow the app language', () => {
    expect(weekdaysMonFirst('hi')[0]).toBe('सो');
    expect(weekdaysMonFirst('en')).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(shortDate('2026-10-14', 'hi')).toBe('14 अक्टूबर');
    expect(shortDate('2026-10-14', 'en')).toBe('14 Oct');
    expect(mondayOffset('2026-10')).toBe(3); // 1 Oct 2026 is a Thursday
    expect(readFileSync('src/screens/ImportReview.jsx', 'utf8')).not.toMatch(/hatana/);
  });
  it('owner-facing copy no longer mentions Firebase rules / OWNER_EMAIL', () => {
    for (const l of ['hi', 'en']) {
      expect(STRINGS[l].farmCheckFailed).not.toMatch(/OWNER_EMAIL|rules/);
      expect(STRINGS[l].setupFailed).not.toMatch(/OWNER_EMAIL|rules/);
    }
  });
  it('unused keys are gone', () => {
    for (const k of ['by', 'at', 'usualLitres', 'rateOverride', 'paneerAmount', 'noPhone', 'bill', 'billFor', 'thankYou', 'contact', 'waOpenChat']) {
      expect(k in STRINGS.en).toBe(false);
    }
    // used dynamically — must stay
    for (const k of ['errNotFound', 'errUsed', 'errExpired', 'errNetwork', 'errAnonDisabled', 'confirmLeave', 'confirmRemoveDevice', 'session_morning']) {
      expect(k in STRINGS.en && k in STRINGS.hi).toBe(true);
    }
  });
});

// ---- 12 / 30 ----
describe('#12 long names fit on the bill photo; #30 no empty band', () => {
  const g = { measureText: (s) => ({ width: Array.from(s).length * 20 }) };
  it('fitText shortens with an ellipsis', () => {
    expect(fitText(g, 'Short', 500)).toBe('Short');
    const out = fitText(g, 'A very very long customer name indeed', 300);
    expect(out.endsWith('…')).toBe(true);
    expect(g.measureText(out).width).toBeLessThanOrEqual(300);
  });
  it('the image height follows the content', () => {
    const row = { paneerG: 0, paneerPaise: 0, previousDuePaise: 0, paidPaise: 0 };
    expect(billHeight(row, '2026-10')).toBeLessThan(1920);
    expect(billHeight(row, '2026-08')).toBeGreaterThan(billHeight(row, '2026-10')); // Aug 2026 needs 6 weeks
  });
});

// ---- 13 ----
describe('#13 PIN lock hides amounts in the rows too', () => {
  it('locked: rows show ₹ •••• instead of balances', () => {
    savePinHash('x');
    const days = { [`${todayISO().slice(0, 7)}-01`]: { entries: { c1: { milkL: 2 } } } };
    render(wrap(<Hisaab fb={mkFb()} customers={[c1]} days={days} payments={[]} settings={settings} month={todayISO().slice(0, 7)} setMonth={() => {}} openCustomer={() => {}} />));
    expect(screen.queryByText('₹120')).toBeNull();
    expect(screen.getAllByText(/₹ ••••/).length).toBeGreaterThan(0);
  });
});

// ---- 18 ----
describe('#18 blank rate keeps the old rate', () => {
  it('saving with an empty milk-rate box does not write milkRatePaise: 0', () => {
    const fb = mkFb();
    render(wrap(<Settings fb={fb} user={{ uid: 'u1', email: 'o@x.in' }} settings={settings} displayName="x" setDisplayName={() => {}} online farm={null} farmId="f" />));
    fireEvent.change(screen.getByLabelText(en.milkRate), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(en.paneerRate), { target: { value: '420.5' } });
    window.confirm = () => true; // rate change asks first (no PIN set)
    fireEvent.click(screen.getByText(en.save));
    const w = fb.writes.find((x) => x.path === 'farms/f/settings/main');
    expect('milkRatePaise' in w.data).toBe(false);
    expect(w.data.paneerRatePaise).toBe(42050);
    expect(screen.getByLabelText(en.milkRate).value).toBe('60');
  });
});

// ---- 19 / 20 ----
describe('#19 customer form validation, #20 deactivate asks first', () => {
  it('special rate ticked but empty -> error, nothing saved', () => {
    const fb = mkFb();
    render(wrap(<CustomerForm fb={fb} initial={null} nextOrder={10} onDone={() => {}} />));
    fireEvent.change(screen.getByLabelText(`${en.name} *`), { target: { value: 'Ram' } });
    fireEvent.click(screen.getByTestId('special-rates'));
    fireEvent.click(screen.getByLabelText(en.customRateToggle));
    fireEvent.click(screen.getByText(en.save));
    expect(screen.getByText(en.rateRequired)).toBeTruthy();
    expect(fb.writes).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(en.customRateLabel), { target: { value: '62.25' } });
    fireEvent.click(screen.getByText(en.save));
    expect(fb.writes[0].data.rateOverridePaise).toBe(6225);
  });
  it('negative usual litres -> error', () => {
    const fb = mkFb();
    const { container } = render(wrap(<CustomerForm fb={fb} initial={null} nextOrder={10} onDone={() => {}} />));
    fireEvent.change(screen.getByLabelText(`${en.name} *`), { target: { value: 'Ram' } });
    fireEvent.change(container.querySelectorAll('.two input.qty')[0], { target: { value: '-1' } });
    fireEvent.click(screen.getByText(en.save));
    expect(screen.getByText(en.qtyInvalid)).toBeTruthy();
    expect(fb.writes).toHaveLength(0);
  });
  it('deactivate: cancel in the confirm keeps the customer active', () => {
    const fb = mkFb();
    const conf = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(wrap(<CustomerForm fb={fb} initial={{ ...c1 }} nextOrder={10} onDone={() => {}} />));
    fireEvent.click(screen.getByText(en.deactivate));
    expect(conf).toHaveBeenCalled();
    expect(fb.writes).toHaveLength(0);
  });
});

// ---- 21 ----
describe('#21 bulk add: no duplicates, no silent bad numbers', () => {
  it('dedupes case-insensitively within the paste and against existing customers', () => {
    const fresh = freshImports(parseImportList('New One\nnew one\n NEW  one \nAsha\nOther'), [{ name: 'asha' }]);
    expect(fresh.map((p) => p.name)).toEqual(['New One', 'Other']);
  });
  it('flags unparsable / negative quantities', () => {
    const [x] = parseImportList('X,abc,-1');
    expect(x.bad).toBe(true);
    expect(parseImportList('Y, 1, 1.5')[0].bad).toBeUndefined();
    expect(freshImports(parseImportList('X,abc,-1'), [])).toHaveLength(0);
  });
});

// ---- 22 ----
describe('#22 bill photos open on last month at the start of a month', () => {
  it('defaultPhotoMonth', () => {
    expect(defaultPhotoMonth('2026-11', '2026-11-01')).toBe('2026-10');
    expect(defaultPhotoMonth('2026-11', '2026-11-03')).toBe('2026-10');
    expect(defaultPhotoMonth('2026-11', '2026-11-04')).toBe('2026-11');
    expect(defaultPhotoMonth('2026-09', '2026-11-01')).toBe('2026-09');
  });
});

// ---- 23 ----
describe('#23 owner sign-out wipes this phone', () => {
  it('clears dd_* keys (not the language), photos, Firestore cache, then signs out', async () => {
    localStorage.setItem('dd_lang', 'hi');
    localStorage.setItem('dd_totals_pin_hash', 'h');
    localStorage.setItem('dd_farm', '{}');
    const fb = mkFb();
    const photos = vi.fn(async () => {});
    await signOutAndWipe(fb, photos);
    expect(photos).toHaveBeenCalled();
    expect(localStorage.getItem('dd_totals_pin_hash')).toBe(null);
    expect(localStorage.getItem('dd_farm')).toBe(null);
    expect(localStorage.getItem('dd_lang')).toBe('hi');
    expect(fb.fsMod.clearIndexedDbPersistence).toHaveBeenCalled();
    expect(fb.authMod.signOut).toHaveBeenCalled();
  });
});

// ---- 24 / 26 / 28 ----
describe('#24 pause label, #26 ✕ only on recorded days, #28 search', () => {
  const t = makeT('en');
  it('pause label only for a current or upcoming pause', () => {
    expect(pauseLabel({ pauseFrom: '2026-01-01', pauseTo: '2026-01-05' }, '2026-10-14', t)).toBe('');
    expect(pauseLabel({ pauseFrom: '2026-10-10', pauseTo: '2026-10-20' }, '2026-10-14', t)).toBe('Paused → 20 October 2026');
    expect(pauseLabel({ pauseFrom: '2026-11-01', pauseTo: '' }, '2026-10-14', t)).toBe('Pause from 1 November 2026');
  });
  it('a day without any entry is not a ✕', () => {
    const days = { '2026-10-02': { entries: { c1: { milkL: 0, skip: true } } } };
    expect(isRecordedGap(days, 'c1', '2026-10-02')).toBe(true);
    expect(isRecordedGap(days, 'c1', '2026-10-01')).toBe(false);
  });
  it('phone search ignores spaces', () => {
    const c = { name: 'Ram', area: 'Station', phone: '98765 43210' };
    expect(matchesQuery(c, '9876543210')).toBe(true);
    expect(matchesQuery(c, '98765 432')).toBe(true);
    expect(matchesQuery(c, 'stat')).toBe(true);
    expect(matchesQuery(c, '11111')).toBe(false);
  });
  it('Register shows "no match" for an empty search result', () => {
    render(wrap(<RegisterView fb={mkFb()} customers={[c1]} days={{}} pendingDays={{}} settings={settings} displayName="x" />));
    fireEvent.change(screen.getByPlaceholderText(en.search), { target: { value: 'zzz' } });
    expect(screen.getByText(en.noResults)).toBeTruthy();
  });
});

// ---- 27 ----
describe('#27 device rename', () => {
  it('blank name keeps the form open; a good rename clears the old error', async () => {
    const fb = mkFb();
    const farm = { ownerUid: 'u1', devices: { u1: { name: 'Papa', addedAt: 1 } } };
    render(wrap(<DevicesCard fb={fb} farm={farm} farmId="f" uid="u1" online now={1} />));
    fireEvent.click(screen.getByText(new RegExp(en.rename)));
    const input = screen.getByLabelText(en.deviceName);
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByText(en.save));
    expect(screen.getByText(en.errInvalidName)).toBeTruthy();
    expect(screen.getByLabelText(en.deviceName)).toBeTruthy(); // still open
    fireEvent.change(screen.getByLabelText(en.deviceName), { target: { value: 'Papa 2' } });
    await act(async () => {
      fireEvent.click(screen.getByText(en.save));
    });
    expect(screen.queryByText(en.errInvalidName)).toBeNull();
    expect(fb.writes.some((w) => w.data['devices.u1.name'] === 'Papa 2')).toBe(true);
  });
});

// ---- 1.10.11 ----
describe('1.10.11 customer form, special paneer rate, day editor', () => {
  const regProps = (fb) => ({
    fb,
    customers: [c1, c2],
    // yesterday filled, so today's register isn't locked (1.10.12)
    days: { [addDays(todayISO(), -40)]: { entries: { c1: { milkL: 1 } } }, [addDays(todayISO(), -1)]: { entries: { c1: { milkL: 1 } } } },
    pendingDays: {},
    settings,
    displayName: 'x',
    onDelivery: () => {},
  });
  afterEach(() => {
    localStorage.removeItem('dd_totals_pin_hash');
    localStorage.removeItem('dd_pin_fails');
  });
  const setPin = async (pin) => {
    const { hashPin, savePinHash } = await import('../src/pinLock.js');
    savePinHash(await hashPin(pin));
  };

  it('edit customer has no Back button at the top', () => {
    render(wrap(<CustomerForm fb={mkFb()} initial={{ ...c1 }} nextOrder={10} onDone={() => {}} />));
    expect(screen.queryByText(new RegExp(`← ${en.back}`))).toBeNull();
  });

  it('special rates are switches; the paneer rate is saved and used by billing', async () => {
    const fb = mkFb();
    render(wrap(<CustomerForm fb={fb} initial={null} nextOrder={10} onDone={() => {}} />));
    fireEvent.change(screen.getByLabelText(`${en.name} *`), { target: { value: 'Ram' } });
    expect(screen.queryByLabelText(en.paneerRateToggle)).toBeNull();
    expect(screen.getByText(en.usesDefaultRates)).toBeTruthy();
    fireEvent.click(screen.getByTestId('special-rates'));
    expect(screen.getByLabelText(en.paneerRateToggle).getAttribute('role')).toBe('switch');
    expect(screen.getByLabelText(en.customRateToggle).getAttribute('role')).toBe('switch');
    expect(screen.getByText(en.usesDefaultPaneerRate)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(en.paneerRateToggle));
    fireEvent.click(screen.getByText(en.save));
    expect(screen.getByText(en.paneerRateRequired)).toBeTruthy();
    expect(fb.writes).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(en.paneerRateLabel), { target: { value: '400' } });
    fireEvent.click(screen.getByText(en.save));
    expect(fb.writes[0].data.paneerRateOverridePaise).toBe(40000);
    expect(fb.writes[0].data.rateOverridePaise).toBe(null);
    const { paneerRateFor } = await import('../src/billing.js');
    const st = { paneerRatePaise: 36000 };
    expect(paneerRateFor(st, null, { paneerRateOverridePaise: 40000 })).toBe(40000);
    expect(paneerRateFor(st, null, {})).toBe(36000); // no special rate -> default
    expect(paneerRateFor(st, { paneerRatePaise: 35000 }, { paneerRateOverridePaise: 40000 })).toBe(35000); // saved entry keeps its rate
  });

  it('turning a special paneer rate off saves null (default rate again)', () => {
    const fb = mkFb();
    render(wrap(<CustomerForm fb={fb} initial={{ ...c1, paneerRateOverridePaise: 40000 }} nextOrder={10} onDone={() => {}} />));
    expect(screen.getByLabelText(en.paneerRateToggle).checked).toBe(true);
    fireEvent.click(screen.getByLabelText(en.paneerRateToggle));
    fireEvent.click(screen.getByText(en.save));
    expect(fb.writes[0].data.paneerRateOverridePaise).toBe(null);
  });

  it('Active: tapping the word does nothing, only the box toggles', () => {
    render(wrap(<CustomerForm fb={mkFb()} initial={null} nextOrder={10} onDone={() => {}} />));
    const box = screen.getByLabelText(en.active);
    expect(box.closest('label')).toBeNull();
    fireEvent.click(screen.getByText(en.active));
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
  });

  it('Deactivate asks for the PIN: wrong PIN keeps the customer, right PIN deactivates', async () => {
    await setPin('4321');
    const fb = mkFb();
    const done = vi.fn();
    const conf = vi.spyOn(window, 'confirm');
    render(wrap(<CustomerForm fb={fb} initial={{ ...c1 }} nextOrder={10} onDone={done} />));
    fireEvent.click(screen.getByText(en.deactivate, { selector: '.btn.danger:not(.small)' }));
    const card = screen.getByTestId('deactivate-pin');
    fireEvent.change(within(card).getByPlaceholderText(en.pinEnter), { target: { value: '1111' } });
    fireEvent.click(within(card).getByText(en.deactivate));
    expect(await within(card).findByText(en.pinWrong)).toBeTruthy();
    expect(fb.writes).toHaveLength(0);
    fireEvent.change(within(card).getByPlaceholderText(en.pinEnter), { target: { value: '4321' } });
    fireEvent.click(within(card).getByText(en.deactivate));
    await waitFor(() => expect(fb.writes).toHaveLength(1));
    expect(fb.writes[0].data.active).toBe(false);
    expect(done).toHaveBeenCalledWith(null);
    expect(conf).not.toHaveBeenCalled();
  });

  it('unticking Active also asks for the PIN', async () => {
    await setPin('4321');
    render(wrap(<CustomerForm fb={mkFb()} initial={{ ...c1 }} nextOrder={10} onDone={() => {}} />));
    const box = screen.getByLabelText(en.active);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    const card = screen.getByTestId('deactivate-pin');
    fireEvent.change(within(card).getByPlaceholderText(en.pinEnter), { target: { value: '4321' } });
    fireEvent.click(within(card).getByText(en.deactivate));
    await waitFor(() => expect(screen.getByLabelText(en.active).checked).toBe(false));
  });

  it('"Edit this day" edits only that day (no ◀ ▶ in the editor)', () => {
    const p = regProps(mkFb());
    p.days = { ...p.days, [todayISO()]: { entries: { c1: { milkL: 1 }, c2: { milkL: 1 } } } };
    render(wrap(<RegisterView {...p} />));
    fireEvent.click(screen.getByText(new RegExp(en.editDay)));
    const ed = screen.getByTestId('day-editor');
    expect(within(ed).queryByLabelText(en.prevDay)).toBeNull();
    expect(within(ed).queryByLabelText(en.nextDay)).toBeNull();
  });

  it('"Edit old records" next to Day total opens the day before, with ◀ ▶', () => {
    render(wrap(<RegisterView {...regProps(mkFb())} />));
    const btn = screen.getByText(new RegExp(en.editOldRecords));
    expect(btn.closest('.day-total-row')).toBeTruthy();
    fireEvent.click(btn);
    const ed = screen.getByTestId('day-editor');
    const y = addDays(todayISO(), -1);
    expect(within(ed).getByRole('heading', { level: 1 }).textContent).toContain(dmy(y));
    expect(within(ed).getByLabelText(en.prevDay)).toBeTruthy();
    fireEvent.click(within(ed).getByLabelText(en.prevDay));
    expect(within(ed).getByRole('heading', { level: 1 }).textContent).toContain(dmy(addDays(todayISO(), -2)));
  });
});

// ---- 1.10.12 ----
import { planRings, lockedBy, dayFilled, firstEntryDay } from '../src/reminders.js';
import DayEditor from '../src/screens/Register.jsx';

describe('1.10.12 rings, lock, payment animation, total-first day editor', () => {
  const T = '2026-10-15';
  const D = (iso, h, m = 0) => {
    const [y, mo, d] = iso.split('-').map(Number);
    return new Date(y, mo - 1, d, h, m);
  };
  const filled = { [addDays(T, -10)]: { entries: { c1: { milkL: 1 } } } };

  it('22:00 ring only while the day is empty; filled before 22:00 = no ring', () => {
    const empty = planRings({ now: D(T, 18), days: filled });
    expect(empty.find((p) => p.kind === 'night' && p.day === T).at).toEqual(D(T, 22));
    const done = planRings({ now: D(T, 18), days: { ...filled, [T]: { entries: { c1: { milkL: 2 } } } } });
    expect(done.find((p) => p.day === T)).toBeUndefined();
  });
  it('still empty -> one more ring at 08:00 next day; nothing in the past is scheduled', () => {
    const p = planRings({ now: D(T, 23), days: filled });
    expect(p.find((x) => x.kind === 'night' && x.day === T)).toBeUndefined(); // 22:00 already gone
    expect(p.find((x) => x.kind === 'morning' && x.day === T).at).toEqual(D(addDays(T, 1), 8));
    // yesterday empty, before 08:00 -> 08:00 today
    const early = planRings({ now: D(T, 6), days: filled });
    expect(early.find((x) => x.kind === 'morning' && x.day === addDays(T, -1)).at).toEqual(D(T, 8));
    // ids unique, every ring in the future
    expect(new Set(early.map((x) => x.id)).size).toBe(early.length);
    early.forEach((x) => expect(x.at > D(T, 6)).toBe(true));
  });
  it('no customers or no entries ever -> no rings, no lock', () => {
    expect(planRings({ now: D(T, 18), days: filled, hasCustomers: false })).toEqual([]);
    expect(lockedBy({ now: D(T, 9), days: {} })).toBe(null);
    expect(firstEntryDay(filled)).toBe(addDays(T, -10));
  });
  it('from 08:00 today is locked while yesterday is empty', () => {
    expect(lockedBy({ now: D(T, 7, 59), days: filled })).toBe(null);
    expect(lockedBy({ now: D(T, 8), days: filled })).toBe(addDays(T, -1));
    const y = { ...filled, [addDays(T, -1)]: { entries: { c2: { milkL: 0, skip: true } } } };
    expect(dayFilled(y, {}, addDays(T, -1))).toBe(true);
    expect(lockedBy({ now: D(T, 9), days: y })).toBe(null);
  });

  const regProps = (fb, days) => ({ fb, customers: [c1, c2], days, pendingDays: {}, settings, displayName: 'x', onDelivery: () => {} });
  it('locked: Delivery and Edit this day are off, the lock card opens yesterday', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(D(todayISO(), 9));
    try {
      const days = { [addDays(todayISO(), -10)]: { entries: { c1: { milkL: 1 } } } };
      render(wrap(<RegisterView {...regProps(mkFb(), days)} />));
      const card = screen.getByTestId('lock-card');
      expect(screen.getByText(new RegExp(en.delivery)).closest('button').disabled).toBe(true);
      const eb = screen.getByTestId('edit-day');
      expect(eb.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(eb);
      expect(screen.queryByTestId('day-editor')).toBeNull();
      expect(screen.getByRole('alert').textContent).toContain(dmy(addDays(todayISO(), -1)));
      fireEvent.click(within(card).getByText(new RegExp(en.fillYesterday)));
      const ed = screen.getByTestId('day-editor');
      expect(within(ed).getByRole('heading', { level: 1 }).textContent).toContain(dmy(addDays(todayISO(), -1)));
    } finally {
      vi.useRealTimers();
    }
  });
  it('Edit this day opens only after every customer\'s entry; before that a tap explains why', () => {
    const y = { [addDays(todayISO(), -1)]: { entries: { c1: { milkL: 1 } } } };
    const partial = { ...y, [todayISO()]: { entries: { c2: { milkL: 1 } } } };
    const { unmount } = render(wrap(<RegisterView {...regProps(mkFb(), partial)} />));
    expect(screen.queryByTestId('lock-card')).toBeNull();
    const eb = screen.getByTestId('edit-day');
    expect(eb.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(eb);
    expect(screen.queryByTestId('day-editor')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(en.editDayNeedsAll.replace('{n}', 1));
    unmount();
    const full = { ...y, [todayISO()]: { entries: { c1: { skip: true, milkL: 0 }, c2: { milkL: 1 } } } };
    render(wrap(<RegisterView {...regProps(mkFb(), full)} />));
    expect(screen.getByTestId('edit-day').getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(screen.getByTestId('edit-day'));
    expect(screen.getByTestId('day-editor')).toBeTruthy();
  });
  it('paneer is in grams: − / + move 100 g, any amount can be typed', async () => {
    const { default: PaneerGrams } = await import('../src/components/PaneerGrams.jsx');
    let kg = 0.25;
    const { rerender } = render(wrap(<PaneerGrams value={kg} onChange={(v) => (kg = v)} />));
    const input = document.querySelector('input.paneer-g');
    expect(input.value).toBe('250');
    expect(input.getAttribute('step')).toBe('100');
    fireEvent.click(screen.getByLabelText('+100'));
    expect(kg).toBe(0.3); // 250 -> next 100
    rerender(wrap(<PaneerGrams value={kg} onChange={(v) => (kg = v)} />));
    fireEvent.click(screen.getByLabelText('+100'));
    expect(kg).toBe(0.4);
    rerender(wrap(<PaneerGrams value={kg} onChange={(v) => (kg = v)} />));
    fireEvent.click(screen.getByLabelText('−100'));
    expect(kg).toBe(0.3);
    fireEvent.change(input, { target: { value: '175' } });
    expect(kg).toBe(0.175);
  });
  it('1.10.25: nothing is saved without Save; Back with changes asks first', () => {
    vi.useFakeTimers();
    try {
      const fb = mkFb();
      const onClose = vi.fn();
      const d = addDays(todayISO(), -6);
      render(wrap(<DayEditor fb={fb} customers={[c1]} days={{ [d]: { entries: { c1: { milkL: 1, milkMorningL: 0, milkEveningL: 0 } } } }} settings={settings} displayName="x" date={d} customerId="c1" lockDate onClose={onClose} />));
      fireEvent.click(document.querySelectorAll('[data-testid="day-editor"] button.step')[1]);
      act(() => vi.advanceTimersByTime(5000));
      expect(fb.writes.filter((x) => x.path.includes('/days/')).length).toBe(0); // no autosave
      const conf = vi.spyOn(window, 'confirm').mockReturnValue(false);
      act(() => handleBack());
      expect(conf).toHaveBeenCalledWith(en.discardUnsaved);
      expect(onClose).not.toHaveBeenCalled(); // stayed
      conf.mockReturnValue(true);
      act(() => handleBack());
      expect(onClose).toHaveBeenCalled();
      expect(fb.writes.filter((x) => x.path.includes('/days/')).length).toBe(0); // thrown away, not saved
    } finally {
      vi.useRealTimers();
    }
  });
  it('the day editor opens on Total, and a total clears morning/evening', () => {
    localStorage.setItem('dd_session', 'morning');
    const fb = mkFb();
    render(wrap(<DayEditor fb={fb} customers={[c1]} days={{}} settings={settings} displayName="x" date={todayISO()} lockDate onClose={() => {}} />));
    const tabs = screen.getAllByRole('tab');
    expect(tabs.find((b) => b.getAttribute('aria-selected') === 'true').textContent).toBe(en.session_total);
    fireEvent.change(document.querySelector('[data-testid="day-editor"] input.qty'), { target: { value: '3' } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText(en.saveAll));
    const w = fb.writes.filter((x) => x.path.includes('/days/'));
    const e = Object.assign({}, ...w.map((x) => x.data.entries)).c1;
    expect(e.milkL).toBe(3);
    expect(e.milkMorningL ?? 0).toBe(0);
    expect(e.milkEveningL ?? 0).toBe(0);
    localStorage.removeItem('dd_session');
  });
  it('Add payment shows "Payment received" with the amount', () => {
    const fb = mkFb();
    render(
      wrap(
        <CustomerDetail
          fb={fb}
          days={{}}
          payments={[]}
          settings={settings}
          displayName="x"
          customerId="c1"
          month={todayISO().slice(0, 7)}
          setMonth={() => {}}
          onBack={() => {}}
          customers={[{ id: 'c1', name: 'Ram', openingDuePaise: 66050 }]}
        />,
      ),
    );
    fireEvent.change(screen.getByLabelText(en.amount), { target: { value: '250' } });
    fireEvent.click(screen.getByText(en.addPayment));
    const anim = screen.getByTestId('payment-received');
    expect(anim.textContent).toContain(en.paymentReceived);
    expect(anim.textContent).toContain('250');
    fireEvent.click(anim);
    expect(screen.queryByTestId('payment-received')).toBeNull();
  });
});

import { ringTimes, validRingTimes } from '../src/reminders.js';
describe('1.10.13 ring times from Settings', () => {
  it('custom times move the rings and the lock', () => {
    const T = '2026-10-15';
    const days = { [addDays(T, -10)]: { entries: { c1: { milkL: 1 } } } };
    const times = ringTimes({ ringNight: '21:30', ringMorning: '06:45' });
    const p = planRings({ now: new Date(2026, 9, 15, 6, 0), days, times });
    expect(p.find((x) => x.kind === 'night' && x.day === T).at).toEqual(new Date(2026, 9, 15, 21, 30));
    expect(p.find((x) => x.kind === 'morning' && x.day === addDays(T, -1)).at).toEqual(new Date(2026, 9, 15, 6, 45));
    expect(lockedBy({ now: new Date(2026, 9, 15, 6, 44), days, times })).toBe(null);
    expect(lockedBy({ now: new Date(2026, 9, 15, 6, 45), days, times })).toBe(addDays(T, -1));
  });
  it('bad or crossed times fall back to 22:00 / 08:00', () => {
    expect(ringTimes({})).toEqual({ night: [22, 0], morning: [8, 0] });
    expect(ringTimes({ ringNight: '07:00', ringMorning: '09:00' })).toEqual({ night: [22, 0], morning: [8, 0] });
    expect(validRingTimes('21:00', '07:00')).toBe(true);
    expect(validRingTimes('07:00', '09:00')).toBe(false);
  });
  it('Settings saves the ring times for every phone', () => {
    const fb = mkFb();
    render(wrap(<Settings fb={fb} user={{ uid: 'u1', email: 'o@x.in' }} settings={settings} displayName="x" setDisplayName={() => {}} online farm={null} farmId="f" />));
    const night = screen.getByLabelText(new RegExp(en.ringNightLabel));
    expect(night.value).toBe('22:00');
    fireEvent.change(night, { target: { value: '21:00' } });
    fireEvent.change(screen.getByLabelText(new RegExp(en.ringMorningLabel)), { target: { value: '07:30' } });
    fireEvent.click(screen.getByText(en.ringSave));
    const w = fb.writes.find((x) => x.path === 'farms/f/settings/main');
    expect(w.data).toEqual({ ringNight: '21:00', ringMorning: '07:30' });
  });
});

describe('1.10.15: Settings Saved/Save button and PIN for rates / UPI', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });
  const S = { milkRatePaise: 6000, paneerRatePaise: 40000, farmName: 'Shiv', upiId: 'shiv9939@ybl', phone: '' };
  const mount = (fb) =>
    render(wrap(<Settings fb={fb} user={{ uid: 'u1', email: 'o@x.in' }} settings={S} displayName="Rahul" setDisplayName={() => {}} online farm={null} farmId="f" />));
  const settingsWrite = (fb) => fb.writes.find((x) => x.path === 'farms/f/settings/main');

  it('nothing changed: white "✓ Saved"; a change turns it into the green Save', () => {
    mount(mkFb());
    const b = screen.getByTestId('settings-save');
    expect(b.textContent).toBe('✓ ' + en.savedState);
    expect(b.className).toContain('saved-btn');
    expect(b.className).not.toContain('primary');
    fireEvent.change(screen.getByLabelText(en.farmName), { target: { value: 'Shiv dairy' } });
    expect(b.textContent).toBe(en.save);
    expect(b.className).toContain('primary');
    fireEvent.change(screen.getByLabelText(en.farmName), { target: { value: 'Shiv' } });
    expect(b.textContent).toBe('✓ ' + en.savedState);
  });
  it('dairy name change saves without any PIN or confirm', () => {
    const fb = mkFb();
    const c = vi.spyOn(window, 'confirm');
    mount(fb);
    fireEvent.change(screen.getByLabelText(en.farmName), { target: { value: 'Shiv dairy' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(c).not.toHaveBeenCalled();
    expect(settingsWrite(fb).data.farmName).toBe('Shiv dairy');
  });
  it('tapping "Saved" with nothing changed writes nothing', () => {
    const fb = mkFb();
    mount(fb);
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(settingsWrite(fb)).toBeUndefined();
  });
  it('no PIN: milk-rate change asks a confirm; No = not saved', () => {
    const fb = mkFb();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount(fb);
    fireEvent.change(screen.getByLabelText(en.milkRate), { target: { value: '65' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(settingsWrite(fb)).toBeUndefined();
  });
  it('PIN set: UPI / rate change saves only after the right PIN', async () => {
    savePinHash(await hashPin('2580'));
    const fb = mkFb();
    mount(fb);
    fireEvent.change(screen.getByLabelText(en.upiId), { target: { value: 'ram123@ybl' } });
    fireEvent.change(screen.getByLabelText(en.paneerRate), { target: { value: '360' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(screen.getByTestId('pin-gate')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(en.pinEnter), { target: { value: '0000' } });
    fireEvent.click(screen.getByText(en.pinGateOk));
    await screen.findByText(en.pinWrong);
    expect(settingsWrite(fb)).toBeUndefined();
    fireEvent.change(screen.getByLabelText(en.pinEnter), { target: { value: '2580' } });
    fireEvent.click(screen.getByText(en.pinGateOk));
    await waitFor(() => expect(settingsWrite(fb)).toBeTruthy());
    expect(settingsWrite(fb).data.upiId).toBe('ram123@ybl');
    expect(settingsWrite(fb).data.paneerRatePaise).toBe(36000);
  });
});

describe('1.10.34 Delivery pre-fill: usual or same as last day', () => {
  const c = { id: 'c1', name: 'Asha', order: 10, usualMorningL: 1, usualEveningL: 1 };
  it('withLastDay uses the last day with milk, skipping Absent / 0 L, else the profile', async () => {
    const { withLastDay } = await import('../src/entry.js');
    const T = todayISO();
    const days = {
      [addDays(T, -3)]: { entries: { c1: { milkL: 3, milkMorningL: 2, milkEveningL: 1 } } },
      [addDays(T, -2)]: { entries: { c1: { milkL: 0, skip: true } } },
      [addDays(T, -1)]: { entries: { c1: { milkL: 0, milkMorningL: 0, milkEveningL: 0 } } },
    };
    const x = withLastDay(c, days, T);
    expect([x.usualMorningL, x.usualEveningL]).toEqual([2, 1]);
    expect(withLastDay(c, {}, T)).toBe(c);
    const tot = withLastDay(c, { [addDays(T, -1)]: { entries: { c1: { milkL: 2.5, milkMorningL: 0, milkEveningL: 0 } } } }, T);
    expect([tot.usualMorningL, tot.usualEveningL]).toEqual([2.5, 0]);
  });
  it('Customer profile: two switches, turning one on turns the other off, saved on the customer', () => {
    const fb = mkFb();
    render(wrap(<CustomerForm fb={fb} initial={c} nextOrder={20} onDone={() => {}} />));
    expect(screen.queryByTestId('prefill-usual')).toBeNull();
    fireEvent.click(screen.getByTestId('milk-format'));
    const st = (m) => screen.getByTestId('prefill-' + m).checked;
    expect([st('usual'), st('lastDay')]).toEqual([true, false]);
    fireEvent.click(screen.getByTestId('prefill-lastDay'));
    expect([st('usual'), st('lastDay')]).toEqual([false, true]);
    fireEvent.click(screen.getByTestId('prefill-usual'));
    expect([st('usual'), st('lastDay')]).toEqual([true, false]);
    fireEvent.click(screen.getByTestId('prefill-usual'));
    expect([st('usual'), st('lastDay')]).toEqual([false, true]);
    fireEvent.click(screen.getByText(STRINGS.en.save));
    expect(fb.writes.at(-1).data).toMatchObject({ prefillMode: 'lastDay' });
  });
  it('Delivery in last-day mode pre-fills yesterday and says "Same as last day"', () => {
    const T = todayISO();
    const days = { [addDays(T, -1)]: { entries: { c1: { milkL: 2.5, milkMorningL: 1.5, milkEveningL: 1 } } } };
    render(wrap(<Delivery fb={mkFb()} customers={[{ ...c, prefillMode: 'lastDay' }]} days={days} settings={settings} displayName="x" onBack={() => {}} />));
    const D = STRINGS.en;
    expect(screen.getByTestId('qty-morning').querySelector('input').value).toBe('1.5');
    expect(screen.getByTestId('as-usual-btn').textContent).toBe(D.sameAsLastDay);
  });
});

describe('1.10.35 pause dates start today or later', () => {
  const c = { id: 'c1', name: 'Asha', order: 10, usualMorningL: 1, usualEveningL: 1 };
  it('date boxes have today as minimum; a past start is refused', () => {
    const fb = mkFb();
    const T = todayISO();
    render(wrap(<CustomerForm fb={fb} initial={c} nextOrder={20} onDone={() => {}} />));
    expect(screen.getByTestId('pause-from').getAttribute('min')).toBe(T);
    expect(screen.getByTestId('pause-to').getAttribute('min')).toBe(T);
    fireEvent.change(screen.getByTestId('pause-from'), { target: { value: addDays(T, -2) } });
    const n = fb.writes.length;
    fireEvent.click(screen.getByText(STRINGS.en.save));
    expect(fb.writes.length).toBe(n);
    expect(screen.getByText(STRINGS.en.pausePast)).toBeTruthy();
    fireEvent.change(screen.getByTestId('pause-from'), { target: { value: addDays(T, 2) } });
    expect(screen.getByTestId('pause-to').getAttribute('min')).toBe(addDays(T, 2));
  });
  it('a pause already running keeps its old start when other fields are edited', () => {
    const fb = mkFb();
    const T = todayISO();
    render(wrap(<CustomerForm fb={fb} initial={{ ...c, pauseFrom: addDays(T, -3), pauseTo: addDays(T, 3) }} nextOrder={20} onDone={() => {}} />));
    fireEvent.click(screen.getByTestId('milk-format'));
    fireEvent.click(screen.getByTestId('prefill-lastDay'));
    fireEvent.click(screen.getByText(STRINGS.en.save));
    expect(fb.writes.at(-1).data).toMatchObject({ prefillMode: 'lastDay' });
  });
});

describe('1.10.36 special rates master switch', () => {
  it('opens when the customer has a special rate; hiding only hides', () => {
    const fb = mkFb();
    render(wrap(<CustomerForm fb={fb} initial={{ id: 'c1', name: 'Asha', order: 10, rateOverridePaise: 5400 }} nextOrder={20} onDone={() => {}} />));
    expect(screen.getByTestId('special-rates').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText(en.customRateToggle).checked).toBe(true);
    fireEvent.click(screen.getByTestId('special-rates'));
    expect(screen.queryByLabelText(en.customRateToggle)).toBeNull();
    fireEvent.change(screen.getByLabelText(`${en.name} *`), { target: { value: 'Asha B' } });
    fireEvent.click(screen.getByText(en.save));
    expect(fb.writes.at(-1).data.rateOverridePaise).toBeUndefined(); // hiding does not change the rate
  });
});
