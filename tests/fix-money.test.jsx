// Money review fixes (check/money.txt section A): #1 #2 #5 #6 #7.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../src/feedback.js', () => ({ playSound: () => {}, vibrateFail: () => {}, saveFeedback: (ok) => ok }));

import { applyPaneerRate, lockNullPaneerRates, listenAll, HIST_KEY } from '../src/db.js';
import { computeMonth } from '../src/billing.js';
import { monthCsv } from '../src/exportExcel.js';
import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { todayISO } from '../src/format.js';
import CustomerDetail from '../src/screens/CustomerDetail.jsx';
import Delivery, { TAP_GUARD_MS } from '../src/screens/Delivery.jsx';
import Hisaab from '../src/screens/Hisaab.jsx';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
const flush = () => new Promise((r) => setTimeout(r, 0));

function batchFb() {
  const ups = [];
  const sets = [];
  let commits = 0;
  return {
    ups,
    sets,
    get commits() {
      return commits;
    },
    farmId: 'f',
    db: {},
    fsMod: {
      doc: (db, ...p) => ({ path: p.join('/'), id: p[p.length - 1] }),
      writeBatch: () => ({ update: (ref, d) => ups.push([ref.path, d]), commit: async () => (commits += 1) }),
      setDoc: async (ref, d) => sets.push([ref.path, d]),
      increment: (n) => ({ inc: n }),
    },
  };
}

// Apply batch updates ("entries.c1.paneerRatePaise": x) onto a days copy.
function applyUps(days, ups) {
  const out = JSON.parse(JSON.stringify(days));
  for (const [path, d] of ups) {
    const iso = path.split('/').pop();
    for (const [k, v] of Object.entries(d)) {
      const [, cid, field] = k.split('.');
      out[iso].entries[cid][field] = v;
    }
  }
  return out;
}

describe('money #1: removed special paneer rate freezes the month', () => {
  const cust = { id: 'c1', name: 'A' };
  const days = { '2026-11-05': { entries: { c1: { paneerKg: 1, paneerRatePaise: 30000 } } } };
  it('removal writes the default in effect now; later Settings change / new special rate do not reprice', () => {
    const fb = batchFb();
    applyPaneerRate(fb, 'c1', null, days, '2026-11-01', 40000);
    const after = applyUps(days, fb.ups);
    expect(after['2026-11-05'].entries.c1.paneerRatePaise).toBe(40000);
    const bill = (c, s) => computeMonth({ customers: [c], days: after, payments: [], settings: s, month: '2026-11' }).rows[0].paneerPaise;
    expect(bill(cust, { paneerRatePaise: 40000 })).toBe(40000);
    expect(bill(cust, { paneerRatePaise: 45000 })).toBe(40000); // Settings changed later
    expect(bill({ ...cust, paneerRateOverridePaise: 25000 }, { paneerRatePaise: 40000 })).toBe(40000); // new special rate in Dec
  });

  it('lockNullPaneerRates freezes null paneer days at today\'s amount, nothing else', () => {
    const customers = [{ id: 'a' }, { id: 'b', paneerRateOverridePaise: 30000 }];
    const settings = { paneerRatePaise: 40000 };
    const d = {
      '2026-09-30': { entries: { a: { paneerKg: 1, paneerRatePaise: null } } }, // before fromIso
      '2026-10-02': {
        entries: {
          a: { paneerKg: 0.5, paneerRatePaise: null },
          b: { paneerKg: 1 }, // missing = null too
          gone: { paneerKg: 1, paneerRatePaise: null }, // deleted customer
        },
      },
      '2026-11-01': {
        entries: {
          a: { milkL: 1, paneerKg: 0, paneerRatePaise: null }, // no paneer
          b: { paneerKg: 1, paneerRatePaise: 35000 }, // already frozen
        },
      },
    };
    const before = ['2026-10', '2026-11'].map((m) => computeMonth({ customers, days: d, payments: [], settings, month: m }).rows.map((r) => r.billedPaise));
    const fb = batchFb();
    const n = lockNullPaneerRates(fb, customers, d, settings, '2026-10-01');
    expect(n).toBe(2);
    expect(fb.ups).toEqual([['farms/f/days/2026-10-02', { 'entries.a.paneerRatePaise': 40000, 'entries.b.paneerRatePaise': 30000 }]]);
    expect(fb.commits).toBe(1);
    const after = applyUps(d, fb.ups);
    const now = ['2026-10', '2026-11'].map((m) => computeMonth({ customers, days: after, payments: [], settings, month: m }).rows.map((r) => r.billedPaise));
    expect(now).toEqual(before);
    // and later rate changes no longer move October
    const later = computeMonth({ customers: [{ id: 'a' }, { id: 'b' }], days: after, payments: [], settings: { paneerRatePaise: 50000 }, month: '2026-10' });
    expect(later.rows.map((r) => r.paneerPaise)).toEqual([20000, 30000]);
    // second run: nothing left to write
    const fb2 = batchFb();
    expect(lockNullPaneerRates(fb2, customers, after, settings, '2026-10-01')).toBe(0);
    expect(fb2.commits).toBe(0);
  });
});

describe('money #2: payment box uses the balance as of today', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 1, 10, 0));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  const days = {};
  for (let i = 1; i <= 31; i++) days[`2026-10-${String(i).padStart(2, '0')}`] = { entries: { a: { milkL: 1, milkRatePaise: 6000 } } };
  days['2026-11-01'] = { entries: { a: { milkL: 1, milkRatePaise: 6000 } } };
  const view = (month, payments) =>
    render(
      wrap(
        <CustomerDetail
          fb={{ farmId: 'F', fsMod: { doc: () => ({ id: 'x' }), collection: () => ({}), setDoc: () => Promise.resolve() } }}
          customers={[{ id: 'a', name: 'Asha' }]}
          days={days}
          payments={payments}
          settings={{ milkRatePaise: 6000, upiId: 'asha@upi' }}
          month={month}
          customerId="a"
          onBack={() => {}}
          displayName="me"
        />,
      ),
    );

  it('October open after paying ₹1,860 on Nov 1: October is cleared, Full = ₹0, no QR (1.10.67: past month = only its own amount)', () => {
    view('2026-10', [{ id: 'p', customerId: 'a', date: '2026-11-01', amountPaise: 186000 }]);
    expect(screen.getByTestId('pay-full').textContent).toContain('₹0');
    expect(screen.queryByTestId('upi-qr-amount')).toBeNull();
    expect(screen.getByTestId('due-today').textContent).toContain('October 2026 due');
    // the bill of the viewed month itself is unchanged
    expect(document.querySelector('.kv.big b').textContent).toContain('1,860');
  });

  it('October open, part paid in Nov: Full = what is left of October only (old dues first)', () => {
    // Oct bill ₹1,860, opening due ₹500 (customer), ₹600 paid on Nov 1 -> old ₹500 cleared, ₹100 of Oct paid.
    render(
      wrap(
        <CustomerDetail
          fb={{ farmId: 'F', fsMod: { doc: () => ({ id: 'x' }), collection: () => ({}), setDoc: () => Promise.resolve() } }}
          customers={[{ id: 'a', name: 'Asha', openingDuePaise: 50000 }]}
          days={days}
          payments={[{ id: 'p', customerId: 'a', date: '2026-11-01', amountPaise: 60000 }]}
          settings={{ milkRatePaise: 6000 }}
          month="2026-10"
          customerId="a"
          onBack={() => {}}
          displayName="me"
        />,
      ),
    );
    expect(screen.getByTestId('pay-full').textContent).toContain('1,760');
    expect(screen.getByTestId('due-today').textContent).toContain('1,760');
  });

  it('current month open: no extra line, Full = balance', () => {
    view('2026-11', []);
    expect(screen.queryByTestId('due-today')).toBeNull();
    expect(screen.getByTestId('pay-full').textContent).toContain('1,920');
  });
});

describe('money #5: CSV keeps customer and supplier payments apart', () => {
  it('two lists, two totals', () => {
    const customers = [{ id: 'a', name: 'Asha' }, { id: 's', name: 'Sup', isSupplier: true }];
    const payments = [
      { id: 'p1', customerId: 'a', date: '2026-11-02', amountPaise: 100000, mode: 'cash' },
      { id: 'p2', customerId: 's', date: '2026-11-03', amountPaise: 500000, mode: 'cash' },
    ];
    const csv = monthCsv({ customers, days: {}, payments, settings: {}, month: '2026-11', lang: 'en' });
    const lines = csv.split('\r\n');
    const totals = lines.filter((l) => l.startsWith('Total,,') && l.split(',').length === 3);
    expect(totals).toEqual(['Total,,1000.00', 'Total,,5000.00']);
    expect(csv).not.toContain('6000.00');
    expect(csv).toContain('Payments – paid to suppliers');
    const iSup = lines.indexOf('Payments – paid to suppliers');
    expect(lines.indexOf('2026-11-03,Sup,5000.00,cash,')).toBeGreaterThan(iSup);
    expect(lines.indexOf('2026-11-02,Asha,1000.00,cash,')).toBeLessThan(iSup);
  });
  it('no supplier payments: one list only', () => {
    const csv = monthCsv({ customers: [{ id: 'a', name: 'Asha' }], days: {}, payments: [{ id: 'p', customerId: 'a', date: '2026-11-02', amountPaise: 100 }], settings: {}, month: '2026-11', lang: 'en' });
    expect(csv).not.toContain('paid to suppliers');
    expect(csv).toContain('Total,,1.00');
  });
});

describe('money #6: Delivery re-save keeps the saved milk rate', () => {
  let now = 1_000_000;
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  const tap = (el) => {
    now += TAP_GUARD_MS + 1;
    fireEvent.click(el);
  };
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
  const c = { id: 'c1', name: 'Asha', order: 10, usualMorningL: 1, usualEveningL: 1 };
  const T = todayISO();
  const days = () => ({ [T]: { entries: { c1: { milkL: 1, milkMorningL: 1, milkEveningL: 0, half: 'morning', milkRatePaise: 6000, paneerKg: 0 } } } });
  const entryWrites = (fb) => fb.writes.filter((w) => w.path.startsWith('farms/f/days/')).map((w) => w.data.entries && w.data.entries.c1).filter(Boolean);

  it('evening delivered after the rate went up: the morning rate stays (no new rate written)', () => {
    const fb = mkFb();
    render(wrap(<Delivery fb={fb} customers={[c]} days={days()} settings={{ milkRatePaise: 6400 }} displayName="x" onBack={() => {}} />));
    tap(screen.getByText(en.delivered));
    const w = entryWrites(fb);
    expect(w.length).toBe(1);
    expect(w[0].milkRatePaise === undefined || w[0].milkRatePaise === 6000).toBe(true);
    expect(w[0].milkRatePaise).not.toBe(6400);
  });

  it('absent keeps the saved rate too', () => {
    const fb = mkFb();
    render(wrap(<Delivery fb={fb} customers={[c]} days={days()} settings={{ milkRatePaise: 6400 }} displayName="x" onBack={() => {}} />));
    tap(screen.getByText(en.absent));
    const w = entryWrites(fb);
    expect(w.length).toBe(1);
    expect(w[0].milkRatePaise).not.toBe(6400);
  });
});

describe('money #7: old history not on this phone is flagged', () => {
  function makeFb({ serverFails }) {
    const listeners = [];
    const empty = (fromCache) => ({ docs: [], metadata: { fromCache } });
    const state = { serverFails };
    const fsMod = {
      doc: (_db, _f, _id, coll, id) => ({ kind: 'doc', coll, id }),
      collection: (_db, _f, _id, coll) => ({ kind: 'col', coll }),
      query: (col, w) => ({ kind: 'q', coll: col.coll, w }),
      where: (field, op, val) => ({ field, op, val }),
      documentId: () => '__id',
      onSnapshot: (target, _o, cb) => {
        listeners.push({ target, cb });
        if (target.kind === 'doc' && target.id === 'history') {
          cb({ exists: () => true, data: () => ({ v: 1 }), metadata: { fromCache: false, hasPendingWrites: false } });
        } else if (target.kind === 'doc') cb({ exists: () => false, data: () => ({}) });
        else cb(empty(true));
        return () => {};
      },
      getDocs: async () => {
        if (state.serverFails) throw new Error('offline');
        return empty(false);
      },
      getDocsFromCache: async () => empty(true),
    };
    return { fb: { farmId: 'F1', db: {}, fsMod }, listeners, state };
  }
  const silence = () => vi.spyOn(console, 'error').mockImplementation(() => {});
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('new phone offline: days handler gets oldOk=false; after a server read it flips to true', async () => {
    silence();
    const { fb, listeners, state } = makeFb({ serverFails: true });
    const got = [];
    listenAll(fb, { settings() {}, customers() {}, days: (d, p, fc, ok) => got.push(ok), payments() {}, error() {} });
    await flush();
    await flush();
    expect(got.at(-1)).toBe(false);
    state.serverFails = false;
    const hist = listeners.find((l) => l.target.kind === 'doc' && l.target.id === 'history');
    hist.cb({ exists: () => true, data: () => ({ v: 1 }), metadata: { fromCache: false, hasPendingWrites: false } });
    await flush();
    await flush();
    expect(got.at(-1)).toBe(true);
  });

  it('phone whose cache still holds the last server read: oldOk=true even offline', async () => {
    silence();
    localStorage.setItem(HIST_KEY, JSON.stringify({ farmId: 'F1', v: 0, cutoff: '2000-01-01', nd: 0, np: 0 }));
    const { fb } = makeFb({ serverFails: true });
    const got = [];
    listenAll(fb, { settings() {}, customers() {}, days: (d, p, fc, ok) => got.push(ok), payments() {}, error() {} });
    await flush();
    await flush();
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((x) => x === true)).toBe(true);
  });

  it('Hisaab and CustomerDetail show the warning only when histOk is false', () => {
    const base = { fb: { farmId: 'F', fsMod: {} }, customers: [{ id: 'a', name: 'Asha' }], days: {}, payments: [], settings: {}, month: todayISO().slice(0, 7), setMonth: () => {} };
    const { unmount } = render(wrap(<Hisaab {...base} openCustomer={() => {}} histOk={false} />));
    expect(screen.getByTestId('old-history-loading').textContent).toBe(en.oldHistoryLoading);
    unmount();
    render(wrap(<Hisaab {...base} openCustomer={() => {}} />));
    expect(screen.queryByTestId('old-history-loading')).toBeNull();
    cleanup();
    render(wrap(<CustomerDetail {...base} customerId="a" onBack={() => {}} histOk={false} />));
    expect(screen.getByTestId('old-history-loading')).toBeTruthy();
    cleanup();
  });
});

