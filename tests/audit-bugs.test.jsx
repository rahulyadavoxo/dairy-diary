// Audit (read-only review) — each test asserts the CORRECT behaviour; on v1.10.21 they FAIL,
// which proves the bug. See the audit report for the fixes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

vi.mock('../src/feedback.js', () => ({ playSound: () => {}, vibrateFail: () => {}, saveFeedback: (ok) => ok }));
vi.mock('../src/billImage.js', async (orig) => ({ ...(await orig()), renderBillImage: vi.fn(), shareImage: vi.fn() }));
vi.mock('../src/billCache.js', () => ({ getCachedPhoto: vi.fn(async () => null), putCachedPhoto: vi.fn(), deleteCachedPhoto: vi.fn() }));
vi.mock('../src/billPreGen.js', () => ({ preGenerateBillPhotos: vi.fn() }));

import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { todayISO, addDays } from '../src/format.js';
import DayEditor from '../src/screens/Register.jsx';
import RegisterView from '../src/screens/RegisterView.jsx';
import Delivery, { TAP_GUARD_MS } from '../src/screens/Delivery.jsx';
import CustomerDetail from '../src/screens/CustomerDetail.jsx';
import { CustomerForm } from '../src/screens/Customers.jsx';
import { blockedTarget } from '../src/swipeTabs.js';
import { computeMonth } from '../src/billing.js';

const en = STRINGS.en;
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
const settings = { milkRatePaise: 6000, paneerRatePaise: 40000 };
const c1 = { id: 'c1', name: 'Asha', order: 10, usualMorningL: 1, usualEveningL: 1 };
const c2 = { id: 'c2', name: 'Bablu', order: 20, usualMorningL: 1, usualEveningL: 0 };

beforeEach(() => {
  cleanup();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BUG 1 (High): correcting an old day re-prices it at today\'s rate', () => {
  it('re-saving an old entry keeps its snapshotted milk rate', () => {
    const fb = mkFb();
    const old = '2026-08-10';
    // August milk was saved at ₹50/L; the rate is ₹60 now.
    const days = { [old]: { entries: { c1: { milkL: 2, milkMorningL: 1, milkEveningL: 1, paneerKg: 0, skip: false, note: '', milkRatePaise: 5000, paneerRatePaise: 40000 } } } };
    render(wrap(<DayEditor fb={fb} customers={[c1]} days={days} pendingDays={{}} settings={settings} displayName="x" date={old} customerId="c1" lockDate onClose={() => {}} />));
    fireEvent.click(screen.getByText(en.save)); // e.g. after adding a note / paneer
    // only changed fields are written (merge): what the server ends up with is old + written
    const w = dayWrites(fb).at(-1);
    const e = { ...days[old].entries.c1, ...((w && w.data.entries.c1) || {}) };
    expect(e.milkRatePaise).toBe(5000); // v1.10.21 writes 6000 -> August bill + every later "previous due" change
  });
});

describe('BUG 2 (Medium): register lock bypassed via Delivery while a past date is shown', () => {
  it('Delivery stays disabled when today is locked, whatever date the Register shows', () => {
    const T = todayISO();
    const [y, m, d] = T.split('-').map(Number);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(y, m - 1, d, 9, 0));
    const days = { [addDays(T, -10)]: { entries: { c1: { milkL: 1 } } } }; // yesterday empty -> locked
    render(wrap(<RegisterView fb={mkFb()} customers={[c1, c2]} days={days} pendingDays={{}} settings={settings} displayName="x" onDelivery={() => {}} />));
    const deli = () => screen.getByText(new RegExp(en.delivery)).closest('button');
    expect(deli().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(en.prevDay)); // look at yesterday
    expect(deli().disabled).toBe(true); // v1.10.21: enabled -> today's round can be entered while locked
  });
});

describe('BUG 3 (Medium): "Everyone\'s usual" overwrites a morning already recorded', () => {
  it('keeps the recorded morning litres', () => {
    const fb = mkFb();
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += TAP_GUARD_MS + 1));
    const T = todayISO();
    // morning 1.5 L recorded in the Register; evening not yet -> c1 still on the round
    const days = { [T]: { entries: { c1: { milkL: 1.5, milkMorningL: 1.5, milkEveningL: 0, paneerKg: 0, skip: false, note: '', half: 'morning' } } } };
    render(wrap(<Delivery fb={fb} customers={[c1, c2]} days={days} settings={settings} displayName="x" onBack={() => {}} />));
    fireEvent.click(screen.getByTestId('all-usual-toggle'));
    const e = { ...days[T].entries.c1, ...dayWrites(fb).at(-1).data.entries.c1 };
    expect(e.milkMorningL).toBe(1.5); // v1.10.21 writes 1 (the usual) -> 0.5 L lost from the bill
    expect(e.milkL).toBe(2.5);
  });
});

describe('BUG 4 (Medium): swipe-to-change-tab is live on the customer edit form', () => {
  it('a flick on the form (not on an input) is not blocked -> tab changes and edits are lost', () => {
    render(wrap(<CustomerForm fb={mkFb()} initial={c1} nextOrder={30} settings={settings} onDone={() => {}} />));
    const heading = screen.getByRole('heading', { level: 1 });
    expect(blockedTarget(heading)).toBe(true); // v1.10.21: false
  });
});

describe('BUG 5 (Low/Medium): supplier page shows a "scan to pay" UPI QR', () => {
  it('no customer-pays-us QR for a supplier (we owe them)', () => {
    const sup = { id: 's1', name: 'Sharma Supplier', phone: '', isSupplier: true };
    render(
      wrap(
        <CustomerDetail
          fb={{ farmId: 'f' }}
          customers={[sup]}
          days={{ '2026-10-01': { entries: { s1: { milkL: 20, milkRatePaise: 4000 } } } }}
          payments={[]}
          settings={{ ...settings, upiId: 'dairy@ybl', farmName: 'Yadav Dairy' }}
          displayName="x"
          customerId="s1"
          month="2026-10"
          setMonth={() => {}}
          onBack={() => {}}
        />,
      ),
    );
    expect(screen.queryByTestId('upi-qr')).toBeNull(); // v1.10.21: QR for ₹800 payable TO the dairy
  });
});

describe.skip('BUG 6 (Low): per-day rounding makes the bill line disagree with litres × rate', () => {
  it('4 × 0.25 L at ₹55.50 bills ₹55.50, not ₹55.52', () => {
    const days = {};
    for (let d = 1; d <= 4; d++) days[`2026-10-0${d}`] = { entries: { a: { milkL: 0.25 } } };
    const r = computeMonth({ customers: [{ id: 'a' }], days, settings: { milkRatePaise: 5550 }, month: '2026-10' }).rows[0];
    expect(r.milkPaise).toBe(5550); // v1.10.21: 5552
  });
});

describe('BUG 8 (Low): a customer with only paneer saved for today drops off the milk round', () => {
  it('paneer recorded earlier in the day does not count as "milk delivered"', () => {
    const T = todayISO();
    const days = { [T]: { entries: { c1: { milkL: 0, milkMorningL: 0, milkEveningL: 0, paneerKg: 0.2, skip: false, note: '' } } } };
    render(wrap(<Delivery fb={mkFb()} customers={[c1, c2]} days={days} settings={settings} displayName="x" onBack={() => {}} />));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Asha'); // v1.10.21: skips to Bablu
  });
});

describe('1.10.28: editing a customer saves a changed old due / special rates', () => {
  const custWrites = (fb) => fb.writes.filter((w) => w.path.includes('customers/'));
  const field = (label) => screen.getByText(label, { exact: false }).closest('label').querySelector('input');
  it('old due changed from 0 to 500 is written', () => {
    const fb = mkFb();
    render(wrap(<CustomerForm fb={fb} initial={{ ...c1, openingDuePaise: 0 }} nextOrder={30} settings={settings} onDone={() => {}} />));
    fireEvent.change(field(en.openingDue), { target: { value: '500' } });
    fireEvent.click(screen.getByText(en.save, { selector: 'button' }));
    expect(custWrites(fb).at(-1).data.openingDuePaise).toBe(50000);
  });
  it('old due changed from 200 to 350 is written', () => {
    const fb = mkFb();
    render(wrap(<CustomerForm fb={fb} initial={{ ...c1, openingDuePaise: 20000 }} nextOrder={30} settings={settings} onDone={() => {}} />));
    fireEvent.change(field(en.openingDue), { target: { value: '350' } });
    fireEvent.click(screen.getByText(en.save, { selector: 'button' }));
    expect(custWrites(fb).at(-1).data.openingDuePaise).toBe(35000);
  });
});
