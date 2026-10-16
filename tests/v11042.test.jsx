import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { listenAll, liveCutoff, saveEntries, addPayment, HIST_KEY } from '../src/db.js';

// Minimal fake of the Firestore functions listenAll uses.
function makeFb({ days, payments, histV = 0 }) {
  const calls = { getDocs: 0, getDocsFromCache: 0, writes: [] };
  const listeners = [];
  const snap = (docs, fromCache = false) => ({
    docs: docs.map(([id, data]) => ({ id, data: () => data, metadata: { hasPendingWrites: false } })),
    metadata: { fromCache },
  });
  const pick = (q) => {
    const src = q.coll === 'days' ? Object.entries(days) : payments.map((p) => [p.id, p]);
    return src.filter(([id, d]) => {
      if (!q.w) return true;
      const key = q.w.field === '__id' ? id : d[q.w.field];
      return q.w.op === '>=' ? key >= q.w.val : key < q.w.val;
    });
  };
  const fsMod = {
    doc: (_db, _f, _id, coll, id) => ({ kind: 'doc', coll, id: id || 'new' + Math.random() }),
    collection: (_db, _f, _id, coll) => ({ kind: 'col', coll }),
    query: (col, w) => ({ kind: 'q', coll: col.coll, w }),
    where: (field, op, val) => ({ field, op, val }),
    documentId: () => '__id',
    increment: (n) => ({ inc: n }),
    onSnapshot: (target, _o, cb) => {
      listeners.push({ target, cb });
      if (target.kind === 'doc' && target.coll === 'settings' && target.id === 'history') {
        cb({ exists: () => true, data: () => ({ v: histV }), metadata: { fromCache: false, hasPendingWrites: false } });
      } else if (target.kind === 'doc') {
        cb({ exists: () => false, data: () => ({}) });
      } else {
        cb(snap(pick(target.kind === 'q' ? target : { coll: target.coll })));
      }
      return () => {};
    },
    getDocs: async (q) => {
      calls.getDocs++;
      return snap(pick(q));
    },
    getDocsFromCache: async (q) => {
      calls.getDocsFromCache++;
      return snap(pick(q), true);
    },
    setDoc: (ref, data) => {
      calls.writes.push({ ref, data });
      return Promise.resolve();
    },
  };
  return { fb: { farmId: 'F1', db: {}, fsMod }, calls, listeners };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('1.10.42 live window + old history', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 16, 10, 0));
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  const data = () => ({
    days: { '2026-05-03': { entries: { a: { milkL: 1 } } }, '2026-10-02': { entries: { a: { milkL: 2 } } } },
    payments: [
      { id: 'p1', customerId: 'a', date: '2026-04-01', amountPaise: 100 },
      { id: 'p2', customerId: 'a', date: '2026-09-01', amountPaise: 200 },
    ],
  });

  it('live window starts on the 1st, two months back', () => {
    expect(liveCutoff('2026-10-16')).toBe('2026-08-01');
    expect(liveCutoff('2026-01-05')).toBe('2025-11-01');
  });

  it('hands the screens the full merged history', async () => {
    const { fb } = makeFb(data());
    const got = {};
    listenAll(fb, { settings() {}, customers() {}, days: (d) => (got.days = d), payments: (p) => (got.pays = p), error() {} });
    await flush();
    await flush();
    expect(Object.keys(got.days).sort()).toEqual(['2026-05-03', '2026-10-02']);
    expect(got.pays.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('reads the old part from the server once, then from the cache while nothing old changed', async () => {
    const d = data();
    const one = makeFb(d);
    listenAll(one.fb, { settings() {}, customers() {}, days() {}, payments() {}, error() {} });
    await flush();
    await flush();
    expect(one.calls.getDocs).toBe(2); // old days + old payments
    expect(JSON.parse(localStorage.getItem(HIST_KEY))).toMatchObject({ v: 0, cutoff: '2026-08-01', nd: 1, np: 1 });

    const two = makeFb(d);
    listenAll(two.fb, { settings() {}, customers() {}, days() {}, payments() {}, error() {} });
    await flush();
    await flush();
    expect(two.calls.getDocs).toBe(0);

    const three = makeFb({ ...d, histV: 1 }); // another phone edited an old record
    listenAll(three.fb, { settings() {}, customers() {}, days() {}, payments() {}, error() {} });
    await flush();
    await flush();
    expect(three.calls.getDocs).toBe(2);
  });

  it('a write to an old date bumps settings/history; a recent one does not', () => {
    const { fb, calls } = makeFb(data());
    saveEntries(fb, '2026-10-15', { a: { milkL: 1 } }, 'me');
    expect(calls.writes.some((w) => w.ref.id === 'history')).toBe(false);
    saveEntries(fb, '2026-06-15', { a: { milkL: 1 } }, 'me');
    addPayment(fb, { customerId: 'a', date: '2026-07-31', amountPaise: 5 });
    const hist = calls.writes.filter((w) => w.ref.id === 'history');
    expect(hist.length).toBe(2);
    expect(hist[0].data.v).toEqual({ inc: 1 });
  });
});

import { monthCsv, exportFileName } from '../src/exportExcel.js';

describe('1.10.42 Excel export', () => {
  it('has the day grid, the bill with previous due and payments, and a payments list', () => {
    const customers = [
      { id: 'a', name: 'Asha, "A"', phone: '9876543210', order: 10, openingDuePaise: 5000 },
      { id: 's', name: 'Supplier', isSupplier: true, order: 20 },
    ];
    const days = {
      '2026-09-30': { entries: { a: { milkL: 1, milkRatePaise: 6000 } } },
      '2026-10-01': { entries: { a: { milkL: 1.5, milkRatePaise: 6000 }, s: { milkL: 10, milkRatePaise: 4000 } } },
      '2026-10-02': { entries: { a: { skip: true } } },
    };
    const payments = [{ id: 'p', customerId: 'a', date: '2026-10-05', amountPaise: 10000, mode: 'cash' }];
    const csv = monthCsv({ customers, days, payments, settings: { milkRatePaise: 6000, farmName: 'Ram Dairy' }, month: '2026-10', lang: 'en' });
    const lines = csv.split('\r\n');
    const asha = lines.find((l) => l.startsWith('1,"Asha, ""A"""'));
    expect(asha).toBeTruthy();
    const cells = asha.split(',').slice(2); // the quoted name has one comma inside
    // phone, day1=1.5, day2=No, ... then totals: 1.5 L, 0 g, milk 90.00, paneer 0.00, bill 90.00, prev 110.00 (50 + 60), paid 100.00, balance 100.00
    expect(cells[1]).toBe('9876543210');
    expect(cells[2]).toBe('1.5');
    expect(cells[3]).toBe('No');
    expect(cells.slice(-8)).toEqual(['1.5', '0', '90.00', '0.00', '90.00', '110.00', '100.00', '100.00']);
    expect(csv).toContain('Suppliers (we buy milk from them)');
    expect(csv).toContain('2026-10-05,"Asha, ""A""",100.00,cash,');
    expect(exportFileName({ farmName: 'Ram Dairy' }, '2026-10')).toBe('Ram_Dairy-2026-10.csv');
  });
});

import { isPaidRow } from '../src/billing.js';
describe('1.10.43 Paid only after a payment is marked', () => {
  it('₹0 bill with no payment is not paid; paid in full or advance is', () => {
    expect(isPaidRow({ balancePaise: 0, paidPaise: 0 })).toBe(false);
    expect(isPaidRow({ balancePaise: 0, paidPaise: 5000 })).toBe(true);
    expect(isPaidRow({ balancePaise: -100, paidPaise: 0 })).toBe(true);
    expect(isPaidRow({ balancePaise: 100, paidPaise: 5000 })).toBe(false);
  });
});
