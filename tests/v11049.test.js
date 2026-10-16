import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
vi.mock('@capacitor/core', async (orig) => ({
  ...(await orig()),
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
  registerPlugin: () => ({ setPending: async (o) => calls.push(o.pending) }),
}));

const { trackWrite, pendingCount, initPendingSync, _resetPendingSync } = await import('../src/pendingSync.js');

describe('1.10.49 background upload: pending write tracking', () => {
  beforeEach(() => {
    calls.length = 0;
    _resetPendingSync();
  });
  it('pending while a write waits for the server; reports only on change', async () => {
    let ok1, ok2;
    const p1 = new Promise((r) => (ok1 = r));
    const p2 = new Promise((r) => (ok2 = r));
    expect(trackWrite(p1)).toBe(p1);
    trackWrite(p2);
    expect(pendingCount()).toBe(2);
    expect(calls).toEqual([true]);
    ok1();
    await p1;
    await Promise.resolve();
    expect(pendingCount()).toBe(1);
    expect(calls).toEqual([true]);
    ok2();
    await p2;
    await Promise.resolve();
    expect(pendingCount()).toBe(0);
    expect(calls).toEqual([true, false]);
  });
  it('a refused write also stops counting', async () => {
    const p = Promise.reject(new Error('rules'));
    trackWrite(p).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(pendingCount()).toBe(0);
    expect(calls).toEqual([true, false]);
  });
  it('writes queued before a restart are tracked through waitForPendingWrites', async () => {
    let done;
    const fb = { db: {}, fsMod: { waitForPendingWrites: () => new Promise((r) => (done = r)) } };
    initPendingSync(fb);
    expect(pendingCount()).toBe(1);
    done();
    await new Promise((r) => setTimeout(r, 0));
    expect(pendingCount()).toBe(0);
  });
});
