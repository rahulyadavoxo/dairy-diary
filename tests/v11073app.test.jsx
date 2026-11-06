// v1.10.73: app shell / rings / updater / sign-in fixes (review check/app.txt #1-3, #5-12 and the
// known "rings on a farm with no entries" item).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';

const st = vi.hoisted(() => ({
  native: false,
  sync: [],
  cancelAll: 0,
  lnCancel: [],
  lnGate: null, // a promise LN.cancel waits on (to hold a sync in flight)
  setPending: [],
  setPendingFail: 0,
}));
vi.mock('@capacitor/core', () => {
  const plugins = {
    DdRing: {
      sync: async (o) => st.sync.push(o),
      cancelAll: async () => (st.cancelAll += 1),
    },
    SyncKeeper: {
      setPending: async (o) => {
        st.setPending.push(o.pending);
        if (st.setPendingFail > 0) {
          st.setPendingFail--;
          throw new Error('bridge not ready');
        }
      },
    },
  };
  const proxy = (o) => new Proxy(o || {}, { get: (t, k) => (k === 'then' ? undefined : t[k]) });
  return {
    Capacitor: { isNativePlatform: () => st.native, isPluginAvailable: (n) => st.native && n === 'DdRing' },
    registerPlugin: (name) => proxy(plugins[name]),
  };
});
vi.mock('@capacitor/local-notifications', () => {
  const impl = {
    createChannel: async () => {},
    registerActionTypes: async () => {},
    addListener: async () => ({ remove() {} }),
    cancel: async (o) => {
      st.lnCancel.push(o);
      if (st.lnGate) await st.lnGate;
    },
    schedule: async () => {},
    checkPermissions: async () => ({ display: 'granted' }),
    requestPermissions: async () => ({ display: 'granted' }),
  };
  return { LocalNotifications: new Proxy(impl, { get: (t, k) => (k === 'then' ? undefined : t[k]) }) };
});
const capApp = vi.hoisted(() => {
  const ls = {};
  return {
    ls,
    fire: (ev, data) => (ls[ev] || []).slice().forEach((fn) => fn(data)),
    App: {
      addListener: (ev, fn) => {
        (ls[ev] = ls[ev] || []).push(fn);
        return Promise.resolve({
          remove: () => {
            ls[ev] = (ls[ev] || []).filter((f) => f !== fn);
          },
        });
      },
      minimizeApp: vi.fn(async () => {}),
      exitApp: vi.fn(async () => {}),
    },
  };
});
vi.mock('@capacitor/app', () => ({ App: capApp.App }));
vi.mock('../src/feedback.js', () => ({ playSound: () => {}, vibrateFail: () => {}, saveFeedback: (ok) => ok }));
// Main's data listeners are not under test here
vi.mock('../src/db.js', async (orig) => ({ ...(await orig()), listenAll: () => () => {} }));

import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { planRings, syncRings, cancelAllRings, _forceRingResync, _resetRingsForTest } from '../src/reminders.js';
import { Gate, appBack } from '../src/App.jsx';
import { listenFarm, confirmRemoved, saveFarmId } from '../src/devices.js';
import UpdateGate from '../src/components/UpdateGate.jsx';
import { AutoBillCard } from '../src/screens/Settings.jsx';
import { trackWrite, _resetPendingSync } from '../src/pendingSync.js';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
const t = (k) => k;
const now = new Date(2026, 10, 6, 18, 0);
const filled = { '2026-11-01': { entries: { c1: { milkL: 1 } } } };
const night = (o, day) => o.rings.find((r) => r.kind === 'night' && r.day === day);

let errSpy;
beforeEach(() => {
  cleanup();
  localStorage.clear();
  _resetRingsForTest();
  st.native = false;
  st.sync = [];
  st.cancelAll = 0;
  st.lnCancel = [];
  st.lnGate = null;
  st.setPending = [];
  st.setPendingFail = 0;
  for (const k of Object.keys(capApp.ls)) delete capApp.ls[k];
  capApp.App.minimizeApp.mockClear();
  capApp.App.exitApp.mockClear();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  vi.useRealTimers();
});

// ---------------------------------------------------------------- known: new farm, no entries
describe('rings on a farm with customers but no entries yet', () => {
  it('no entry ever -> no rings planned', () => {
    expect(planRings({ now, days: {}, pendingDays: {}, hasCustomers: true })).toEqual([]);
  });
  it('after the first entry the rings start', () => {
    const p = planRings({ now, days: filled, pendingDays: {}, hasCustomers: true });
    expect(p.some((r) => r.kind === 'night' && r.day === '2026-11-06')).toBe(true);
  });
});

// ---------------------------------------------------------------- #1 serialised syncRings
describe('#1 syncRings: an older plan never lands after a newer one', () => {
  const args = (times) => ({ days: filled, pendingDays: {}, hasCustomers: true, t, dmy: (x) => x, now, times, auth: { farmId: 'f' } });
  const T22 = { night: [22, 0], morning: [8, 0] };
  const T21 = { night: [21, 0], morning: [8, 0] };

  it('two calls back to back (cache then server): only the newest plan is sent', async () => {
    st.native = true;
    const a = syncRings(args(T22));
    const b = syncRings(args(T21));
    await Promise.all([a, b]);
    expect(st.sync.length).toBe(1);
    expect(night(st.sync[0], '2026-11-06').at).toBe(new Date(2026, 10, 6, 21, 0).getTime());
  });

  it('first call still in its legacy clear when the second starts: native ends with the newer plan', async () => {
    st.native = true;
    let release;
    st.lnGate = new Promise((r) => (release = r));
    const a = syncRings(args(T22));
    await waitFor(() => expect(st.lnCancel.length).toBe(1)); // call 1 is in flight
    const b = syncRings(args(T21));
    st.lnGate = null;
    release();
    await Promise.all([a, b]);
    const last = st.sync[st.sync.length - 1];
    expect(night(last, '2026-11-06').at).toBe(new Date(2026, 10, 6, 21, 0).getTime());
  });

  it('cancelAllRings drops a sync that has not started yet', async () => {
    st.native = true;
    syncRings(args(T22));
    await cancelAllRings();
    await new Promise((r) => setTimeout(r, 0));
    expect(st.sync.length).toBe(0);
    expect(st.cancelAll).toBeGreaterThanOrEqual(1);
  });

  it('#9 _forceRingResync re-sends an unchanged plan (native cleared it after a 403)', async () => {
    st.native = true;
    await syncRings(args(T22));
    await syncRings(args(T22));
    expect(st.sync.length).toBe(1);
    _forceRingResync();
    await syncRings(args(T22));
    expect(st.sync.length).toBe(2);
  });
});

// ---------------------------------------------------------------- #9 RingReceiver 403
describe('#9 RingReceiver: one 403 does not clear the plan', () => {
  const rx = readFileSync('android/app/src/main/java/in/dairydiary/app/RingReceiver.java', 'utf8');
  it('403 is FORBIDDEN; the plan is cleared only on the 2nd 403 in a row or a dead sign-in', () => {
    expect(rx).toContain('if (code == 403) return FORBIDDEN;');
    expect(rx).toContain('if (n >= 2) server = NO_ACCESS;');
    expect(rx).toContain('INVALID_REFRESH_TOKEN');
    expect(rx).toMatch(/FORBIDDEN = -3/);
  });
  it('App re-sends the ring plan on resume', () => {
    const app = readFileSync('src/App.jsx', 'utf8');
    expect(app).toContain("CapApp.addListener('resume'");
    expect(app).toContain('_forceRingResync();');
  });
});

// ---------------------------------------------------------------- fake Firestore for Gate
function fakeFb({ server = null } = {}) {
  const subs = [];
  const fsMod = {
    doc: (_db, ...path) => ({ path: path.join('/'), id: path[path.length - 1] }),
    onSnapshot: (_ref, _o, next, err) => {
      const s = { next, err, live: true };
      subs.push(s);
      return () => {
        s.live = false;
      };
    },
    terminate: vi.fn(async () => {}),
    clearIndexedDbPersistence: vi.fn(async () => {}),
  };
  if (server) fsMod.getDocFromServer = vi.fn(server);
  const authMod = { signOut: vi.fn(async () => {}), updateProfile: async () => {}, signInAnonymously: vi.fn() };
  const last = () => subs.filter((s) => s.live).at(-1);
  return {
    fb: { db: {}, fsMod, authMod, auth: { currentUser: null } },
    subs,
    emit: (data, meta = {}) => last().next({ exists: () => !!data, data: () => data, metadata: { fromCache: false, hasPendingWrites: false, ...meta } }),
    fail: (code) => last().err({ code }),
  };
}
const farm = { ownerUid: 'own', devices: { own: { name: 'Papa' }, p2: { name: 'Bhai' } } };
const docSnap = (data) => ({ exists: () => !!data, data: () => data });

// ---------------------------------------------------------------- #5 permission-denied
describe('#5 one permission-denied does not wipe a helper phone', () => {
  it('server says still a member -> no wipe, app stays on the last farm', async () => {
    saveFarmId('p2', 'own');
    const { fb, emit, fail } = fakeFb({ server: async () => docSnap(farm) });
    render(wrap(<Gate fb={fb} user={{ uid: 'p2', isAnonymous: true }} />));
    act(() => emit(farm));
    await waitFor(() => expect(document.querySelector('.tabbar')).toBeTruthy());
    act(() => fail('permission-denied'));
    await waitFor(() => expect(fb.fsMod.getDocFromServer).toHaveBeenCalled());
    await act(async () => {});
    expect(fb.fsMod.terminate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('removed')).toBeNull();
    expect(document.querySelector('.tabbar')).toBeTruthy();
  });
  it('re-check fails with a network error -> no wipe', async () => {
    saveFarmId('p2', 'own');
    const { fb, fail } = fakeFb({
      server: async () => {
        throw { code: 'unavailable' };
      },
    });
    render(wrap(<Gate fb={fb} user={{ uid: 'p2', isAnonymous: true }} />));
    act(() => fail('permission-denied'));
    await waitFor(() => expect(fb.fsMod.getDocFromServer).toHaveBeenCalled());
    await act(async () => {});
    expect(fb.fsMod.terminate).not.toHaveBeenCalled();
  });
  it('server also denies -> wiped and locked', async () => {
    saveFarmId('p2', 'own');
    const { fb, fail } = fakeFb({
      server: async () => {
        throw { code: 'permission-denied' };
      },
    });
    render(wrap(<Gate fb={fb} user={{ uid: 'p2', isAnonymous: true }} />));
    act(() => fail('permission-denied'));
    await waitFor(() => expect(screen.getByTestId('removed')).toBeTruthy());
    expect(fb.fsMod.terminate).toHaveBeenCalled();
  });
  it('confirmRemoved: uid missing on the server = removed; member; unknown', async () => {
    const mk = (server) => fakeFb({ server }).fb;
    expect(await confirmRemoved(mk(async () => docSnap({ devices: { own: {} } })), 'own', 'p2')).toBe('removed');
    expect(await confirmRemoved(mk(async () => docSnap(null)), 'own', 'p2')).toBe('removed');
    expect(await confirmRemoved(mk(async () => docSnap(farm)), 'own', 'p2')).toBe('member');
    expect(await confirmRemoved(mk(async () => Promise.reject({ code: 'unavailable' })), 'own', 'p2')).toBe('unknown');
  });
});

// ---------------------------------------------------------------- #6 other listener errors
describe('#6 other farm-listener errors keep the app and retry', () => {
  it('quota error after an authorised snapshot: still in the app, no "waiting for server" wall', async () => {
    const { fb, emit, fail } = fakeFb();
    render(wrap(<Gate fb={fb} user={{ uid: 'own', email: 'o@x.in', isAnonymous: false }} />));
    act(() => emit(farm));
    await waitFor(() => expect(document.querySelector('.tabbar')).toBeTruthy());
    act(() => fail('resource-exhausted'));
    expect(screen.queryByTestId('farm-error')).toBeNull();
    expect(document.querySelector('.tabbar')).toBeTruthy();
  });
  it('error before any good snapshot still shows the retry screen', () => {
    const { fb, fail } = fakeFb();
    render(wrap(<Gate fb={fb} user={{ uid: 'own', email: 'o@x.in', isAnonymous: false }} />));
    act(() => fail('unavailable'));
    expect(screen.getByTestId('farm-error')).toBeTruthy();
  });
  it('listenFarm re-subscribes after a non-denied error, not after permission-denied', async () => {
    const { fb, subs } = fakeFb();
    const cb = vi.fn();
    const stop = listenFarm(fb, 'own', cb, 10);
    subs[0].err({ code: 'resource-exhausted' });
    await waitFor(() => expect(subs.length).toBe(2));
    subs[1].err({ code: 'permission-denied' });
    await new Promise((r) => setTimeout(r, 40));
    expect(subs.length).toBe(2);
    stop();
    expect(subs[1].live).toBe(false);
  });
});

// ---------------------------------------------------------------- #8 sign-out cancels rings
describe('#8 Sign out on the farm-error screen stops the rings', () => {
  it('cancels the native rings and signs out', async () => {
    st.native = true;
    const { fb, fail } = fakeFb();
    render(wrap(<Gate fb={fb} user={{ uid: 'own', email: 'o@x.in', isAnonymous: false }} />));
    act(() => fail('permission-denied'));
    fireEvent.click(screen.getByText(en.signOut));
    expect(fb.authMod.signOut).toHaveBeenCalled();
    await waitFor(() => expect(st.cancelAll).toBeGreaterThanOrEqual(1));
  });
});

// ---------------------------------------------------------------- #10 Back outside Main
describe('#10 hardware Back on Login / Join / Setup goes to Welcome', () => {
  it('Login -> Back -> Welcome; Welcome -> Back -> exit', () => {
    const { fb } = fakeFb();
    render(wrap(<Gate fb={fb} user={null} />));
    fireEvent.click(screen.getByText(en.welcomeOwner));
    expect(screen.getByTestId('login')).toBeTruthy();
    act(() => {
      expect(appBack()).toBe('handled');
    });
    expect(screen.getByTestId('welcome')).toBeTruthy();
    act(() => {
      expect(appBack()).toBe('exit');
    });
    expect(capApp.App.exitApp).toHaveBeenCalled();
  });
  it('Join -> Back -> Welcome', () => {
    const { fb } = fakeFb();
    render(wrap(<Gate fb={fb} user={null} />));
    fireEvent.click(screen.getByText(en.welcomeJoin));
    expect(screen.getByTestId('join-farm')).toBeTruthy();
    act(() => {
      appBack();
    });
    expect(screen.getByTestId('welcome')).toBeTruthy();
  });
  it('SetupFarm (owner, no farm yet) -> Back signs out', () => {
    const { fb, emit } = fakeFb();
    render(wrap(<Gate fb={fb} user={{ uid: 'own', email: 'o@x.in', isAnonymous: false }} />));
    act(() => emit(null));
    expect(screen.getByTestId('setup-farm')).toBeTruthy();
    act(() => {
      expect(appBack()).toBe('handled');
    });
    expect(fb.authMod.signOut).toHaveBeenCalled();
  });
  it('one backButton listener lives in App (not only in Main)', () => {
    const app = readFileSync('src/App.jsx', 'utf8');
    expect(app.match(/addListener\('backButton'/g).length).toBe(1);
    expect(app).toContain('useAppBackButton();');
  });
});

// ---------------------------------------------------------------- #2 / #3 update wall
const apiWith = (over = {}) => ({
  current: vi.fn(async () => '1.10.72'),
  check: vi.fn(async () => ({ version: '1.10.73', url: 'u' })),
  download: vi.fn(async () => {}),
  install: vi.fn(async () => ({ started: true })),
  canInstall: vi.fn(async () => false),
  sync: vi.fn(async () => {}),
  ...over,
});
const resume = () => act(async () => capApp.fire('appStateChange', { isActive: true }));

describe('#2 "Install unknown apps" is never re-opened on resume', () => {
  it('resume without the permission: only checks, stays on the wall, offers "Use the app now"', async () => {
    const api = apiWith({ install: vi.fn(async () => ({ needsPermission: true })) });
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => screen.getByTestId('update-gate'));
    fireEvent.click(screen.getByTestId('update-btn'));
    await waitFor(() => screen.getByText(en.updPermHint));
    expect(screen.queryByTestId('update-later')).toBeNull();
    await waitFor(() => expect(capApp.ls.appStateChange && capApp.ls.appStateChange.length).toBe(1));
    await resume();
    await waitFor(() => expect(api.canInstall).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(api.install).toHaveBeenCalledTimes(1); // settings NOT opened again
    await waitFor(() => screen.getByTestId('update-later'));
    fireEvent.click(screen.getByTestId('update-later'));
    expect(screen.queryByTestId('update-gate')).toBeNull();
    // tapping Update opens settings again (user's choice)
  });
  it('resume with the permission now on: opens the installer', async () => {
    let allowed = false;
    const api = apiWith({
      install: vi.fn(async () => (allowed ? { started: true } : { needsPermission: true })),
      canInstall: vi.fn(async () => allowed),
    });
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => screen.getByTestId('update-gate'));
    fireEvent.click(screen.getByTestId('update-btn'));
    await waitFor(() => screen.getByText(en.updPermHint));
    await waitFor(() => expect(capApp.ls.appStateChange && capApp.ls.appStateChange.length).toBe(1));
    allowed = true;
    await resume();
    await waitFor(() => expect(api.install).toHaveBeenCalledTimes(2));
    await waitFor(() => screen.getByText(en.updInstallHint));
  });
  it('ApkUpdaterPlugin has a check-only canInstall; appUpdate wraps it', () => {
    const j = readFileSync('android/app/src/main/java/in/dairydiary/app/ApkUpdaterPlugin.java', 'utf8');
    expect(j).toMatch(/@PluginMethod\s+public void canInstall\(PluginCall call\)/);
    expect(j).toContain('canRequestPackageInstalls()');
    const js = readFileSync('src/appUpdate.js', 'utf8');
    expect(js).toContain('ApkUpdater.canInstall()');
    expect(js).toContain("'uploaded'"); // updater still only accepts uploaded assets
  });
});

describe('#3 installer that keeps failing: escape after 2 tries', () => {
  it('2nd return from the installer without an update -> "Use the app now" + free-space hint', async () => {
    const api = apiWith();
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => screen.getByTestId('update-gate'));
    fireEvent.click(screen.getByTestId('update-btn'));
    await waitFor(() => screen.getByText(en.updInstallHint));
    expect(screen.queryByTestId('update-later')).toBeNull();
    fireEvent.click(screen.getByTestId('update-btn'));
    await waitFor(() => expect(api.install).toHaveBeenCalledTimes(2));
    await waitFor(() => screen.getByTestId('update-later'));
    expect(screen.getByText(en.updInstallFailedHint)).toBeTruthy();
    expect(api.download).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- #7 AutoBillCard follows server
describe('#7 auto-bill form follows the server while untouched', () => {
  const fb = { fsMod: {}, db: {}, farmId: 'f' };
  it('another phone turns auto-bill on: the box follows, no stale green Save', () => {
    const view = render(wrap(<AutoBillCard fb={fb} settings={{}} isOwner waApi={{}} />));
    expect(screen.getByTestId('autobill-on').checked).toBe(false);
    view.rerender(wrap(<AutoBillCard fb={fb} settings={{ autoBill: { enabled: true, day: 3, time: '10:00' } }} isOwner waApi={{}} />));
    expect(screen.getByTestId('autobill-on').checked).toBe(true);
    expect(screen.getByTestId('autobill-day').value).toBe('3');
    expect(screen.getByTestId('autobill-time').value).toBe('10:00');
  });
  it('what the user changed is kept when the server changes something', () => {
    const view = render(wrap(<AutoBillCard fb={fb} settings={{}} isOwner waApi={{}} />));
    fireEvent.change(screen.getByTestId('autobill-day'), { target: { value: '5' } });
    view.rerender(wrap(<AutoBillCard fb={fb} settings={{ autoBill: { enabled: true, day: 2, time: '09:00' } }} isOwner waApi={{}} />));
    expect(screen.getByTestId('autobill-day').value).toBe('5');
  });
});

// ---------------------------------------------------------------- #11 ring pair
describe('#11 ring times are saved as a pair', () => {
  it('Settings writes ringNight and ringMorning together', () => {
    const s = readFileSync('src/screens/Settings.jsx', 'utf8');
    expect(s).toContain('saveSettings(fb, { ringNight: ring.night, ringMorning: ring.morning });');
  });
});

// ---------------------------------------------------------------- #12 pendingSync retry
describe('#12 pending flag: a failed native call is sent again', () => {
  it('setPending rejects once -> retried, native ends with pending=true', async () => {
    st.native = true;
    _resetPendingSync();
    st.setPendingFail = 1;
    trackWrite(new Promise(() => {})); // stays pending
    await waitFor(() => expect(st.setPending).toEqual([true, true]), { timeout: 4000 });
    _resetPendingSync();
  });
});
