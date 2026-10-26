// v1.10.55: native register ring. It checks at ring time whether ANY phone filled the day
// (the brother's phone), rings on the loud ALARM stream, and the old LN rings are dropped.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const st = vi.hoisted(() => ({ sync: [], cancelAll: 0, lnCancel: [], lnSchedule: 0 }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n) => n === 'DdRing' },
  registerPlugin: () =>
    new Proxy(
      {
        sync: async (o) => st.sync.push(o),
        cancelAll: async () => (st.cancelAll += 1),
      },
      { get: (t, k) => (k === 'then' ? undefined : t[k]) },
    ),
}));
vi.mock('@capacitor/local-notifications', () => {
  const impl = {
    createChannel: async () => {},
    registerActionTypes: async () => {},
    addListener: async () => ({ remove() {} }),
    cancel: async (o) => st.lnCancel.push(o),
    schedule: async () => (st.lnSchedule += 1),
    checkPermissions: async () => ({ display: 'granted' }),
    requestPermissions: async () => ({ display: 'granted' }),
  };
  return { LocalNotifications: new Proxy(impl, { get: (t, k) => (k === 'then' ? undefined : t[k]) }) };
});

import { syncRings, cancelAllRings, filledDays, _resetRingsForTest } from '../src/reminders.js';

const t = (k) => k;
const now = new Date(2026, 9, 26, 18, 0);
const auth = { apiKey: 'k', projectId: 'p', farmId: 'f1', refreshToken: 'rt' };
const base = { '2026-10-20': { entries: { c1: { milkL: 1 } } } };

describe('native ring (1.10.55)', () => {
  beforeEach(() => {
    _resetRingsForTest();
    st.sync = [];
    st.lnCancel = [];
    st.lnSchedule = 0;
    st.cancelAll = 0;
  });

  it('hands the plan + auth to the native ring, never schedules LN rings, drops the old LN ids once', async () => {
    await syncRings({ days: base, pendingDays: {}, hasCustomers: true, t, dmy: (x) => x, now, auth });
    expect(st.lnSchedule).toBe(0);
    expect(st.lnCancel.length).toBe(1);
    expect(st.lnCancel[0].notifications.length).toBe(15);
    const o = st.sync[0];
    expect(o.auth).toEqual(auth);
    const tonight = o.rings.find((r) => r.kind === 'night' && r.day === '2026-10-26');
    expect(tonight.at).toBe(new Date(2026, 9, 26, 22, 0).getTime());
    expect(tonight.title).toContain('ringTitle');
    expect(o.closeTitle).toBe('ringClose');
  });

  it('filled before the ring time -> tonight is not planned and the day is in the filled list', async () => {
    await syncRings({ days: base, pendingDays: {}, hasCustomers: true, t, dmy: (x) => x, now, auth });
    const days = { ...base, '2026-10-26': { entries: { c1: { milkL: 2 } } } };
    await syncRings({ days, pendingDays: {}, hasCustomers: true, t, dmy: (x) => x, now, auth });
    const o = st.sync[1];
    expect(o.rings.some((r) => r.day === '2026-10-26')).toBe(false);
    expect(o.filled).toContain('2026-10-26');
    expect(st.lnCancel.length).toBe(1); // legacy cleanup only once
  });

  it('same plan -> no second native call; sign-out cancels the native rings', async () => {
    await syncRings({ days: base, pendingDays: {}, hasCustomers: true, t, dmy: (x) => x, now, auth });
    await syncRings({ days: base, pendingDays: {}, hasCustomers: true, t, dmy: (x) => x, now, auth });
    expect(st.sync.length).toBe(1);
    await cancelAllRings();
    expect(st.cancelAll).toBe(1);
  });

  it('filledDays covers yesterday .. 7 days ahead', () => {
    const d = { '2026-10-25': { entries: { a: {} } }, '2026-10-24': { entries: { a: {} } }, '2026-11-02': { entries: { a: {} } } };
    expect(filledDays({ now, days: d })).toEqual(['2026-10-25', '2026-11-02']);
  });
});

describe('native ring source', () => {
  const rx = readFileSync('android/app/src/main/java/in/dairydiary/app/RingReceiver.java', 'utf8');
  const man = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
  const main = readFileSync('android/app/src/main/java/in/dairydiary/app/MainActivity.java', 'utf8');
  it('checks Firestore before ringing and rings on the alarm stream', () => {
    expect(rx).toContain('filledOnServer');
    expect(rx).toContain('/days/');
    expect(rx).toContain('USAGE_ALARM');
    expect(rx).toContain('STREAM_ALARM');
    expect(rx).toContain('restoreVolume');
  });
  it('receiver + boot permission registered, plugin registered', () => {
    expect(man).toContain('.RingReceiver');
    expect(man).toContain('RECEIVE_BOOT_COMPLETED');
    expect(main).toContain('registerPlugin(RingPlugin.class)');
  });
});
