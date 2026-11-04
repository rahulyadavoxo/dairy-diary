// v1.10.70: a rate change applies from that moment; saved days keep their rate.
import { describe, it, expect } from 'vitest';
import { lockCurrentRates } from '../src/db.js';

function mkFb() {
  const ups = [];
  return {
    ups, farmId: 'f', db: {},
    fsMod: {
      doc: (db, ...p) => ({ path: p.join('/') }),
      writeBatch: () => ({ update: (ref, d) => ups.push([ref.path, d]), commit: async () => 1, set: () => {} }),
      setDoc: async () => {}, increment: (n) => n, serverTimestamp: () => 0,
    },
  };
}

describe('lockCurrentRates', () => {
  const customers = [{ id: 'c1', rateOverridePaise: 6000 }, { id: 'c2' }];
  const settings = { milkRatePaise: 5500, paneerRatePaise: 40000 };
  const days = {
    '2026-11-01': { entries: { c1: { milkL: 1, milkRatePaise: 6000 }, c2: { milkL: 2, milkRatePaise: null, paneerKg: 0.5, paneerRatePaise: null } } },
    '2026-11-02': { entries: { c1: { milkL: 1, milkRatePaise: null }, c2: { skip: true, milkL: 0 } } },
  };
  it('freezes only days without a snapshot, at the rate in effect now', () => {
    const fb = mkFb();
    const n = lockCurrentRates(fb, customers, days, settings);
    expect(n).toBe(3);
    const all = Object.assign({}, ...fb.ups.filter((u) => u[0].includes('/days/')).map((u) => u[1]));
    expect(all).toEqual({ 'entries.c2.milkRatePaise': 5500, 'entries.c2.paneerRatePaise': 40000, 'entries.c1.milkRatePaise': 6000 });
  });
  it('one customer only', () => {
    const fb = mkFb();
    expect(lockCurrentRates(fb, customers, days, settings, 'c1')).toBe(1);
  });
});
