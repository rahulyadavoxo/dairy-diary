// Regression tests for the 1.9.8 UI-audit fixes (one block per audit item that has logic).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';

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
import { savePinHash } from '../src/pinLock.js';

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
const sup = { id: 's1', name: 'Supplier Sharma', order: 5, usualMorningL: 20, usualEveningL: 0, isSupplier: true, phone: '9999999999' };
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
  it('the evening round lists a customer who got morning milk, and keeps the morning litres', () => {
    setRound('evening');
    const fb = mkFb();
    const days = { [todayISO()]: { entries: { c1: { milkL: 1, milkMorningL: 1, milkEveningL: 0 } } } };
    render(wrap(<Delivery {...deliProps(fb, { days })} />));
    expect(screen.getByText('Asha')).toBeTruthy();
    expect(screen.queryByText('Bablu')).toBeNull(); // no evening milk usually
    fireEvent.click(screen.getByText(en.asUsual, { selector: 'button' }));
    const e = dayWrites(fb)[0].data.entries.c1;
    expect([e.milkMorningL, e.milkEveningL, e.milkL]).toEqual([1, 1, 2]);
  });
  it('"Everyone\'s usual" in the morning round writes only morning milk', () => {
    setRound('morning');
    const fb = mkFb();
    render(wrap(<Delivery {...deliProps(fb)} />));
    fireEvent.click(screen.getByText(en.markAllUsual));
    const entries = dayWrites(fb)[0].data.entries;
    expect(Object.keys(entries).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(entries.c1.milkEveningL).toBe(0);
    expect(entries.c1.milkL).toBe(1);
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

describe('#16 Skip survives leaving delivery; empty list says so', () => {
  it('a skipped customer stays skipped after re-opening', () => {
    setRound('total');
    const fb = mkFb();
    render(wrap(<Delivery {...deliProps(fb)} />));
    fireEvent.click(screen.getByText(en.skipDelivery));
    cleanup();
    render(wrap(<Delivery {...deliProps(fb)} />));
    expect(screen.queryByText('Asha')).toBeNull();
    expect(screen.getByText('Bablu')).toBeTruthy();
    expect(dayWrites(fb)).toHaveLength(0); // skip is not written as an entry
  });
  it('a customer marked "didn\'t take" for the day in the register is not on the round', () => {
    setRound('total');
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
  const regProps = (fb, extra = {}) => ({ fb, customers: [c1, c2], days: {}, pendingDays: {}, settings, displayName: 'x', onDelivery: () => {}, ...extra });
  it('"Edit this day" opens the editor for that date and saves through saveEntries', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fb = mkFb();
    render(wrap(<RegisterView {...regProps(fb)} />));
    fireEvent.click(screen.getByLabelText(en.prevDay));
    const y = addDays(todayISO(), -1);
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
    fireEvent.click(screen.getByLabelText(`${dd}-${mm}-${yy}`));
    const ed = screen.getByTestId('day-editor');
    expect(within(ed).getByRole('heading', { level: 1 }).textContent).toContain('Asha');
    expect(within(ed).queryByText(/Bablu/)).toBeNull();
    act(() => {
      handleBack();
    });
    expect(screen.queryByTestId('day-editor')).toBeNull();
  });
  it('future dates in the calendar are not editable', () => {
    render(wrap(<RegisterView {...regProps(mkFb())} />));
    fireEvent.click(screen.getByText(/Asha/));
    const t = addDays(todayISO(), 1);
    if (t.slice(0, 7) === todayISO().slice(0, 7)) {
      const [yy, mm, dd] = t.split('-');
      expect(screen.getByLabelText(`${dd}-${mm}-${yy}`).disabled).toBe(true);
    }
  });
});

// ---- 6 ----
describe('#6 suppliers stay out of customer flows', () => {
  it('not in the delivery round', () => {
    expect(deliveryList([sup, c1], {}, todayISO(), 'total').map((c) => c.id)).toEqual(['c1']);
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
    fireEvent.click(screen.getByText(`📲 ${en.waBillsTitle}`));
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
    expect(pauseLabel({ pauseFrom: '2026-10-10', pauseTo: '2026-10-20' }, '2026-10-14', t)).toBe('Paused → 20-10-2026');
    expect(pauseLabel({ pauseFrom: '2026-11-01', pauseTo: '' }, '2026-10-14', t)).toBe('Pause from 01-11-2026');
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
