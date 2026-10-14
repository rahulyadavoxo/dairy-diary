// Register reminders and the "fill yesterday first" lock.
//
// Rules (user, 15 Oct 2026):
//  - 22:00 every day: if that day's register has not been filled from ANY phone, every logged-in
//    phone rings once (15 s sound, notification with a Close button). Filled before 22:00 = no ring.
//  - Still not filled: every phone rings once more at 08:00 the next morning.
//  - From 08:00 on, today's register (Register "Edit this day", Delivery) is locked until the
//    previous day's register is filled (via "Edit old records" / the lock card).
//
// "Filled" = the day has at least one saved entry (milk, skip or paneer) for any customer,
// including entries still waiting to sync from this phone.
//
// The rings are local notifications scheduled on each phone. A phone cancels its rings as soon as
// it sees (through Firestore sync) that the day was filled; a phone that stays closed and offline
// can't know that, so it may still ring.

import { Capacitor } from '@capacitor/core';
import { addDays, isoDate } from './format.js';

export const NIGHT_HOUR = 22;
export const MORNING_HOUR = 8;
export const RING_SOUND = 'dd_ring.ogg';
export const RING_CHANNEL = 'dd_ring_v1';
export const RING_ACTION_TYPE = 'DD_RING';
const AHEAD = 7; // days scheduled ahead, so phones that aren't opened for a while still ring
const NIGHT_BASE = 7100; // ids 7100..7106: 22:00 of today+k
const MORNING_BASE = 7200; // ids 7200..7207: 08:00 of today+k (for the day before)
const ALL_IDS = [...Array(AHEAD).keys()].map((k) => NIGHT_BASE + k).concat([...Array(AHEAD + 1).keys()].map((k) => MORNING_BASE + k));

/** Has the register for `iso` been filled (any entry, synced or pending)? */
// (days already holds this phone's unsynced writes too; pendingDays is only a flag map.)
export function dayFilled(days, pendingDays, iso) {
  const d = days && days[iso];
  return !!(d && d.entries && Object.keys(d.entries).length > 0);
}

/** First date with any entry (null = nothing ever entered). */
export function firstEntryDay(days) {
  let first = null;
  for (const [iso, d] of Object.entries(days || {})) {
    if (d && d.entries && Object.keys(d.entries).length > 0 && (!first || iso < first)) first = iso;
  }
  return first;
}

const at = (iso, hour) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, hour, 0, 0, 0);
};

/**
 * Which earlier day blocks today's register? From 08:00, today is locked while yesterday is empty.
 * Returns yesterday's ISO date, or null. Nothing locks before the farm's first entry.
 */
export function lockedBy({ now = new Date(), days, pendingDays, hasCustomers = true }) {
  if (!hasCustomers) return null;
  const first = firstEntryDay(days);
  if (!first) return null;
  const today = isoDate(now);
  const y = addDays(today, -1);
  if (y < first) return null;
  if (now.getHours() < MORNING_HOUR) return null;
  return dayFilled(days, pendingDays, y) ? null : y;
}

/** The rings this phone should have pending right now. */
export function planRings({ now = new Date(), days, pendingDays, hasCustomers = true }) {
  if (!hasCustomers) return [];
  const today = isoDate(now);
  const first = firstEntryDay(days);
  const out = [];
  // yesterday still empty -> 08:00 today
  const y = addDays(today, -1);
  const ym = at(today, MORNING_HOUR);
  if (first && y >= first && ym > now && !dayFilled(days, pendingDays, y)) out.push({ id: MORNING_BASE, kind: 'morning', day: y, at: ym });
  for (let k = 0; k < AHEAD; k++) {
    const d = addDays(today, k);
    if (dayFilled(days, pendingDays, d)) continue;
    const night = at(d, NIGHT_HOUR);
    if (night > now) out.push({ id: NIGHT_BASE + k, kind: 'night', day: d, at: night });
    const morn = at(addDays(d, 1), MORNING_HOUR);
    if (morn > now) out.push({ id: MORNING_BASE + 1 + k, kind: 'morning', day: d, at: morn });
  }
  return out;
}

const native = () => {
  try {
    return !!(Capacitor.isNativePlatform && Capacitor.isNativePlatform());
  } catch {
    return false;
  }
};

let ready = null;
let lastSig = '';

// NB: a Capacitor plugin proxy must never be the resolved value of a promise (await would call
// its .then(), which the proxy reports as "not implemented"). Always pass it wrapped: { LN }.
async function plugin() {
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  return { LN: LocalNotifications };
}

async function setup(t) {
  const { LN } = await plugin();
  try {
    await LN.createChannel({
      id: RING_CHANNEL,
      name: t('ringChannel'),
      description: t('ringChannel'),
      importance: 5,
      visibility: 1,
      vibration: true,
      sound: RING_SOUND,
    });
  } catch {
    /* web / old Android */
  }
  try {
    await LN.registerActionTypes({ types: [{ id: RING_ACTION_TYPE, actions: [{ id: 'close', title: t('ringClose') }] }] });
  } catch {
    /* ignore */
  }
  try {
    await LN.addListener('localNotificationActionPerformed', async (a) => {
      if (!a || !a.notification || a.notification.actionTypeId !== RING_ACTION_TYPE) return;
      try {
        await LN.cancel({ notifications: [{ id: a.notification.id }] });
      } catch {
        /* ignore */
      }
      if (a.actionId === 'close') {
        try {
          const { App } = await import('@capacitor/app');
          if (App.minimizeApp) await App.minimizeApp();
        } catch {
          /* ignore */
        }
      }
    });
  } catch {
    /* ignore */
  }
  return { LN };
}

/** Bring this phone's pending rings in line with the register. Safe to call often. */
export async function syncRings({ days, pendingDays, hasCustomers, t, dmy, now = new Date() }) {
  if (!native()) return;
  const plan = planRings({ now, days, pendingDays, hasCustomers });
  const sig = plan.map((p) => `${p.id}@${p.at.getTime()}`).join(',');
  if (sig === lastSig) return;
  lastSig = sig;
  try {
    if (!ready) ready = setup(t);
    const { LN } = await ready;
    const keep = new Set(plan.map((p) => p.id));
    const drop = ALL_IDS.filter((id) => !keep.has(id)).map((id) => ({ id }));
    if (drop.length) await LN.cancel({ notifications: drop });
    if (!plan.length) return;
    await LN.schedule({
      notifications: plan.map((p) => ({
        id: p.id,
        title: '🥛 ' + t('ringTitle'),
        body: (p.kind === 'night' ? t('ringNight') : t('ringMorning')).replace('{date}', dmy(p.day)),
        schedule: { at: p.at, allowWhileIdle: true },
        channelId: RING_CHANNEL,
        sound: RING_SOUND,
        actionTypeId: RING_ACTION_TYPE,
        autoCancel: true,
        foreground: true,
        smallIcon: 'ic_stat_dd',
        iconColor: '#1f6f43',
        extra: { kind: p.kind, day: p.day },
      })),
    });
  } catch (e) {
    lastSig = ''; // try again next time
    console.error('[rings]', e);
  }
}

export function _resetRingsForTest() {
  ready = null;
  lastSig = '';
}

/** Signed out / removed from the farm: this phone stops ringing. */
export async function cancelAllRings() {
  lastSig = '';
  if (!native()) return;
  try {
    const { LN } = await plugin();
    await LN.cancel({ notifications: ALL_IDS.map((id) => ({ id })) });
  } catch {
    /* ignore */
  }
}
