import { describe, it, expect, vi, beforeEach } from 'vitest';

const ln = vi.hoisted(() => ({ calls: [] }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/local-notifications', () => {
  // a thenable-hostile proxy, like Capacitor's: awaiting it directly would throw
  const impl = {
    createChannel: async (o) => ln.calls.push(['createChannel', o]),
    registerActionTypes: async (o) => ln.calls.push(['registerActionTypes', o]),
    addListener: async () => ({ remove() {} }),
    cancel: async (o) => ln.calls.push(['cancel', o]),
    schedule: async (o) => ln.calls.push(['schedule', o]),
  };
  const LocalNotifications = new Proxy(impl, {
    get(t, k) {
      if (k === 'then') return () => Promise.reject(new Error('then() is not implemented'));
      return t[k];
    },
  });
  return { LocalNotifications };
});

import { syncRings, cancelAllRings, _resetRingsForTest, RING_SOUND, RING_CHANNEL } from '../src/reminders.js';

const t = (k) => ({ ringNight: 'Today {date}', ringMorning: 'Yesterday {date}', ringTitle: 'DD', ringClose: 'Close', ringChannel: 'Rem' })[k] || k;
const days = { '2026-10-05': { entries: { c1: { milkL: 1 } } } };

describe('syncRings on the phone', () => {
  beforeEach(() => {
    ln.calls.length = 0;
    _resetRingsForTest();
  });
  it('creates the 15 s ring channel + Close action and schedules the rings once', async () => {
    const now = new Date(2026, 9, 15, 18, 0);
    await syncRings({ days, pendingDays: {}, hasCustomers: true, t, dmy: (x) => x, now });
    const ch = ln.calls.find((c) => c[0] === 'createChannel')[1];
    expect(ch).toMatchObject({ id: RING_CHANNEL, sound: RING_SOUND, importance: 5 });
    expect(ln.calls.find((c) => c[0] === 'registerActionTypes')[1].types[0].actions[0]).toEqual({ id: 'close', title: 'Close' });
    const sch = ln.calls.find((c) => c[0] === 'schedule')[1].notifications;
    const tonight = sch.find((n) => n.extra.kind === 'night' && n.extra.day === '2026-10-15');
    expect(tonight.schedule.at).toEqual(new Date(2026, 9, 15, 22, 0));
    expect(tonight.body).toBe('Today 2026-10-15');
    expect(tonight.sound).toBe(RING_SOUND);
    expect(tonight.actionTypeId).toBe('DD_RING');
    // same plan again -> nothing re-scheduled
    ln.calls.length = 0;
    await syncRings({ days, pendingDays: {}, hasCustomers: true, t, dmy: (x) => x, now });
    expect(ln.calls).toEqual([]);
  });
  it('filling today cancels tonight\'s and tomorrow-morning\'s ring', async () => {
    const now = new Date(2026, 9, 15, 18, 0);
    await syncRings({ days, pendingDays: {}, hasCustomers: true, t, dmy: (x) => x, now });
    ln.calls.length = 0;
    await syncRings({ days: { ...days, '2026-10-15': { entries: { c1: { milkL: 2 } } } }, pendingDays: {}, hasCustomers: true, t, dmy: (x) => x, now });
    const cancelled = ln.calls.find((c) => c[0] === 'cancel')[1].notifications.map((n) => n.id);
    expect(cancelled).toContain(7100); // tonight
    expect(cancelled).toContain(7201); // 08:00 tomorrow for today
    const sch = ln.calls.find((c) => c[0] === 'schedule')[1].notifications;
    expect(sch.find((n) => n.extra.day === '2026-10-15')).toBeUndefined();
  });
  it('sign out cancels every ring', async () => {
    await cancelAllRings();
    expect(ln.calls[0][0]).toBe('cancel');
    expect(ln.calls[0][1].notifications.length).toBe(15);
  });
});
