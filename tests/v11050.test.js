import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const ln = vi.hoisted(() => ({ calls: [], perm: 'prompt', after: 'granted', opened: 0 }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({ openNotificationSettings: async () => (ln.opened += 1) }),
}));
vi.mock('@capacitor/local-notifications', () => {
  const impl = {
    createChannel: async () => {},
    registerActionTypes: async () => {},
    addListener: async () => ({ remove() {} }),
    cancel: async () => {},
    schedule: async (o) => ln.calls.push(['schedule', o]),
    checkPermissions: async () => ({ display: ln.perm }),
    requestPermissions: async () => {
      ln.calls.push(['request']);
      ln.perm = ln.after;
      return { display: ln.perm };
    },
  };
  return { LocalNotifications: new Proxy(impl, { get: (t, k) => (k === 'then' ? undefined : t[k]) }) };
});

import { syncRings, ringPermission, askRingPermission, _resetRingsForTest } from '../src/reminders.js';

const t = (k) => k;
const days = { '2026-10-05': { entries: { c1: { milkL: 1 } } } };

describe('1.10.50 register ring: notification permission', () => {
  beforeEach(() => {
    ln.calls.length = 0;
    ln.opened = 0;
    _resetRingsForTest();
  });
  it('asks for notifications (Android 13+) before scheduling the first rings', async () => {
    ln.perm = 'prompt';
    ln.after = 'granted';
    await syncRings({ days, pendingDays: {}, hasCustomers: true, t, dmy: (x) => x, now: new Date(2026, 9, 15, 18, 0) });
    const order = ln.calls.map((c) => c[0]);
    expect(order.indexOf('request')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('request')).toBeLessThan(order.indexOf('schedule'));
  });
  it('never re-prompts a phone that already denied; Settings can check and open the settings page', async () => {
    ln.perm = 'denied';
    ln.after = 'denied';
    await syncRings({ days, pendingDays: {}, hasCustomers: true, t, dmy: (x) => x, now: new Date(2026, 9, 15, 18, 0) });
    expect(ln.calls.some((c) => c[0] === 'request')).toBe(false);
    expect(await ringPermission()).toBe('denied');
    expect(await askRingPermission()).toBe('denied');
    expect(ln.opened).toBe(1);
  });
  it('the upload notification ids never collide with ring ids 7100-7207', () => {
    const src = readFileSync('android/app/src/main/java/in/dairydiary/app/SyncKeepService.java', 'utf8');
    const ids = [...src.matchAll(/_ID = (\d+)/g)].map((m) => Number(m[1]));
    expect(ids.length).toBe(2);
    ids.forEach((id) => expect(id < 7100 || id > 7207).toBe(true));
  });
});
