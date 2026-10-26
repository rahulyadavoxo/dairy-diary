// v1.10.56: special paneer rate change / removal applies to this month's days; a day without
// paneer keeps no paneer rate.
import { describe, it, expect } from 'vitest';
import { applyPaneerRate } from '../src/db.js';
import { normaliseEntry } from '../src/entry.js';
import { entryCharge } from '../src/billing.js';

function mkFb() {
  const ups = [];
  let commits = 0;
  return {
    ups,
    get commits() {
      return commits;
    },
    farmId: 'f',
    db: {},
    fsMod: {
      doc: (db, ...p) => ({ path: p.join('/') }),
      writeBatch: () => ({ update: (ref, d) => ups.push([ref.path, d]), commit: async () => (commits += 1) }),
    },
  };
}

const days = {
  '2026-09-30': { entries: { c1: { paneerKg: 1, paneerRatePaise: 30000 } } },
  '2026-10-02': { entries: { c1: { paneerKg: 0.5, paneerRatePaise: 30000 }, c2: { paneerKg: 1, paneerRatePaise: 30000 } } },
  '2026-10-03': { entries: { c1: { milkL: 1, paneerKg: 0, paneerRatePaise: 30000 } } },
  '2026-10-04': { entries: { c1: { paneerKg: 1, paneerRatePaise: 40000 } } },
};

describe('applyPaneerRate', () => {
  it('new rate -> this month, this customer, paneer days get it; milk-only days lose the rate', () => {
    const fb = mkFb();
    const n = applyPaneerRate(fb, 'c1', 40000, days, '2026-10-01');
    expect(n).toBe(2);
    expect(fb.ups).toEqual([
      ['farms/f/days/2026-10-02', { 'entries.c1.paneerRatePaise': 40000 }],
      ['farms/f/days/2026-10-03', { 'entries.c1.paneerRatePaise': null }],
    ]);
    expect(fb.commits).toBe(1);
  });
  it('removed -> null, so the Settings default rate bills again', () => {
    const fb = mkFb();
    applyPaneerRate(fb, 'c1', null, days, '2026-10-01');
    expect(fb.ups.map((u) => u[1]['entries.c1.paneerRatePaise'])).toEqual([null, null, null]);
    const charge = entryCharge({ paneerKg: 1, paneerRatePaise: null }, { id: 'c1' }, { paneerRatePaise: 30000 });
    expect(charge.paneerPaise).toBe(30000);
  });
  it('nothing differs -> no write', () => {
    const fb = mkFb();
    expect(applyPaneerRate(fb, 'c2', 30000, days, '2026-10-01')).toBe(0);
    expect(fb.commits).toBe(0);
  });
});

describe('normaliseEntry paneer rate', () => {
  it('a milk-only day stores no paneer rate; a paneer day stores the special rate', () => {
    const cust = { id: 'c1', paneerRateOverridePaise: 40000 };
    expect(normaliseEntry(cust, { milkL: 1, paneerKg: 0 }, { paneerRatePaise: 30000 }).paneerRatePaise).toBe(null);
    expect(normaliseEntry(cust, { milkL: 1, paneerKg: 0.5 }, { paneerRatePaise: 30000 }).paneerRatePaise).toBe(40000);
  });
});
