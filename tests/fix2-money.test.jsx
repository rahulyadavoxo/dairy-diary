// fix2-money: NEW-3 (paneer lock guard), NEW-4 (CSV payments skip deleted customers), NEW-5 (BillPhotos warning)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { maybeLockPaneer, paneerLockKey, resetPaneerLockForTests } from '../src/paneerLock.js';
const PANEER_LOCK_KEY = paneerLockKey({ farmId: 'f' }); // v1.10.73: per farm
import { listenAll } from '../src/db.js';
import { computeMonth } from '../src/billing.js';
import { monthCsv } from '../src/exportExcel.js';
import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { todayISO } from '../src/format.js';
import Hisaab from '../src/screens/Hisaab.jsx';
import BillPhotos from '../src/screens/BillPhotos.jsx';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;

function batchFb() {
  const ups = [];
  return {
    ups,
    farmId: 'f',
    db: {},
    fsMod: {
      doc: (db, ...p) => ({ path: p.join('/'), id: p[p.length - 1] }),
      writeBatch: () => ({ update: (ref, d) => ups.push([ref.path, d]), commit: async () => {} }),
      setDoc: async () => {},
      increment: (n) => ({ inc: n }),
    },
  };
}

describe('NEW-3: one-time paneer lock waits for server data and old history', () => {
  const customers = [{ id: 'a', name: 'A' }];
  const days = { '2026-10-02': { entries: { a: { paneerKg: 1, paneerRatePaise: null } } } };
  const ready = { loaded: { days: true, customers: true, settings: true }, daysLive: true, customersLive: true, settingsLive: true, histOk: true };
  beforeEach(() => {
    localStorage.clear();
    resetPaneerLockForTests();
  });

  it('waits (not marked done) while old history is missing or any list is only a cache copy', () => {
    const settings = { paneerRatePaise: 40000 };
    for (const miss of [
      { histOk: false },
      { daysLive: false },
      { customersLive: false },
      { settingsLive: false },
      { loaded: { days: true, customers: true, settings: false } },
      { loaded: { days: false, customers: true, settings: true } },
    ]) {
      const fb = batchFb();
      expect(maybeLockPaneer({ fb, ...ready, ...miss, settings, customers, days }).state).toBe('wait');
      expect(fb.ups).toEqual([]);
      expect(localStorage.getItem(PANEER_LOCK_KEY)).toBeNull();
    }
  });

  it('runs once when everything is server-confirmed, then is done', async () => {
    const settings = { paneerRatePaise: 40000 };
    const fb = batchFb();
    const r = maybeLockPaneer({ fb, ...ready, settings, customers, days });
    expect(r).toMatchObject({ state: 'ran', n: 1 });
    expect(await r.done).toBe(true);
    expect(fb.ups).toEqual([['farms/f/days/2026-10-02', { 'entries.a.paneerRatePaise': 40000 }]]);
    expect(localStorage.getItem(PANEER_LOCK_KEY)).toBeTruthy();
    const fb2 = batchFb();
    expect(maybeLockPaneer({ fb: fb2, ...ready, settings, customers, days }).state).toBe('done');
    expect(fb2.ups).toEqual([]);
  });

  it('farm without a default paneer rate: skipped without marking done; runs once a default is set', () => {
    const fb = batchFb();
    expect(maybeLockPaneer({ fb, ...ready, settings: {}, customers, days }).state).toBe('skip');
    expect(maybeLockPaneer({ fb, ...ready, settings: { paneerRatePaise: 0 }, customers, days }).state).toBe('skip');
    expect(fb.ups).toEqual([]);
    expect(localStorage.getItem(PANEER_LOCK_KEY)).toBeNull();
    expect(maybeLockPaneer({ fb, ...ready, settings: { paneerRatePaise: 45000 }, customers, days }).state).toBe('ran');
  });

  it('listenAll tells settings/customers handlers whether the copy came from the cache', () => {
    const got = { s: [], c: [] };
    const fsMod = {
      doc: (_db, _f, _id, coll, id) => ({ kind: 'doc', coll, id }),
      collection: (_db, _f, _id, coll) => ({ kind: 'col', coll }),
      onSnapshot: (target, _o, cb) => {
        if (target.kind === 'doc') {
          cb({ exists: () => true, data: () => ({ x: 1 }), metadata: { fromCache: true } });
          cb({ exists: () => true, data: () => ({ x: 1 }), metadata: { fromCache: false } });
        } else if (target.coll === 'customers') {
          cb({ docs: [], metadata: { fromCache: true } });
          cb({ docs: [], metadata: { fromCache: false } });
        } else cb({ docs: [], metadata: { fromCache: false } });
        return () => {};
      },
    };
    const stop = listenAll({ farmId: 'F', db: {}, fsMod }, {
      settings: (s, fc) => got.s.push(fc),
      customers: (c, fc) => got.c.push(fc),
      days() {},
      payments() {},
      error() {},
    });
    stop();
    expect(got.s).toEqual([true, false]);
    expect(got.c).toEqual([true, false]);
  });
});

describe('NEW-4: CSV customer payments total matches Hisaab collected', () => {
  it('payments of deleted customers are left out', () => {
    const customers = [{ id: 'a', name: 'Asha' }];
    const payments = [
      { id: 'p1', customerId: 'a', date: '2026-11-02', amountPaise: 10000, mode: 'cash' },
      { id: 'p2', customerId: 'gone', date: '2026-11-03', amountPaise: 50000, mode: 'cash' },
    ];
    const csv = monthCsv({ customers, days: {}, payments, settings: {}, month: '2026-11', lang: 'en' });
    const totals = csv.split('\r\n').filter((l) => l.startsWith('Total,,') && l.split(',').length === 3);
    expect(totals).toEqual(['Total,,100.00']);
    expect(csv).not.toContain('500.00');
    const res = computeMonth({ customers, days: {}, payments, settings: {}, month: '2026-11' });
    expect(res.totals.collectedPaise).toBe(10000);
  });
});

describe('NEW-5: Bill Photos shows the old-history warning', () => {
  const base = { customers: [{ id: 'a', name: 'Asha' }], days: {}, payments: [], settings: {}, month: todayISO().slice(0, 7) };
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('BillPhotos: warning only when histOk is false', () => {
    const { unmount } = render(wrap(<BillPhotos {...base} histOk={false} onClose={() => {}} />));
    expect(screen.getByTestId('old-history-loading').textContent).toBe(en.oldHistoryLoading);
    unmount();
    render(wrap(<BillPhotos {...base} onClose={() => {}} />));
    expect(screen.queryByTestId('old-history-loading')).toBeNull();
  });

  it('Hisaab passes histOk to Bill Photos', () => {
    render(wrap(<Hisaab {...base} fb={{ farmId: 'F', fsMod: {} }} setMonth={() => {}} openCustomer={() => {}} histOk={false} />));
    fireEvent.click(screen.getByText(en.billPhotosShort, { exact: false }));
    expect(screen.getByText(en.billPhotos)).toBeTruthy();
    expect(screen.getByTestId('old-history-loading')).toBeTruthy();
  });
});
