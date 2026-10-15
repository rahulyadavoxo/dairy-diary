// Audit: switching the app language does not re-schedule the pending ring texts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ln = vi.hoisted(() => ({ calls: [] }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    createChannel: async () => {},
    registerActionTypes: async () => {},
    addListener: async () => ({ remove() {} }),
    cancel: async (o) => ln.calls.push(['cancel', o]),
    schedule: async (o) => ln.calls.push(['schedule', o]),
  },
}));
import { syncRings, _resetRingsForTest } from '../src/reminders.js';

const days = { '2026-10-05': { entries: { c1: { milkL: 1 } } } };
const hi = (k) => ({ ringNight: 'आज {date}', ringTitle: 'DD', ringMorning: 'कल {date}' })[k] || k;
const en = (k) => ({ ringNight: 'Today {date}', ringTitle: 'DD', ringMorning: 'Yesterday {date}' })[k] || k;

describe('BUG 7 (Low): ring text stays in the old language', () => {
  beforeEach(() => {
    ln.calls.length = 0;
    _resetRingsForTest();
  });
  it('language change re-schedules the rings with the new text', async () => {
    const now = new Date(2026, 9, 15, 18, 0);
    await syncRings({ days, pendingDays: {}, hasCustomers: true, t: hi, dmy: (x) => x, now });
    ln.calls.length = 0;
    await syncRings({ days, pendingDays: {}, hasCustomers: true, t: en, dmy: (x) => x, now });
    const sch = ln.calls.find((c) => c[0] === 'schedule');
    expect(sch && sch[1].notifications[0].body).toMatch(/Today|Yesterday/); // v1.10.21: nothing re-scheduled
  });
});
