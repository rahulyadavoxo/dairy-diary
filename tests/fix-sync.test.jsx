// Regression tests for the app shell / sync / update review (sync.txt section C, 14 findings).
import { useState, useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
vi.mock('../src/feedback.js', () => ({ playSound: () => {}, vibrateFail: () => {}, saveFeedback: (ok) => ok }));
import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import Settings from '../src/screens/Settings.jsx';
import UpdateGate, { SKIP_KEY } from '../src/components/UpdateGate.jsx';
import { checkForUpdate, releaseFromTag } from '../src/appUpdate.js';
import { pinWaitSeconds, hashPin, savePinHash } from '../src/pinLock.js';
import { usePinGate } from '../src/components/PinGate.jsx';
import { saveEntries } from '../src/db.js';
import { markMemCache, offlineSaveBroken, isMemFallbackLog, MEMCACHE_EVENT } from '../src/firebase.js';
import { Gate } from '../src/App.jsx';
import DevicesCard from '../src/components/DevicesCard.jsx';
import { saveFarmId } from '../src/devices.js';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;

function mkFb() {
  const writes = [];
  const ref = (...parts) => ({ path: parts.filter((p) => typeof p === 'string').join('/') });
  return {
    writes,
    farmId: 'f',
    db: {},
    auth: { currentUser: {} },
    authMod: { updateProfile: vi.fn(async () => {}) },
    fsMod: {
      doc: (...a) => ref(...a.slice(1)),
      collection: (...a) => ref(...a.slice(1)),
      setDoc: vi.fn(async (r, data) => writes.push({ path: r.path, data })),
    },
  };
}
const settingsWrites = (fb) => fb.writes.filter((x) => x.path === 'farms/f/settings/main');

let onLineSpy = null;
const setOnline = (v) => {
  onLineSpy = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(v);
};

let errSpy = null;
beforeEach(() => {
  cleanup();
  localStorage.clear();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // expected rejections are logged
});
afterEach(() => {
  errSpy.mockRestore();
  if (onLineSpy) onLineSpy.mockRestore();
  onLineSpy = null;
  vi.useRealTimers();
});

// ---------------------------------------------------------------- #1 / #4 update wall
const apiWith = (over = {}) => ({
  current: vi.fn(async () => '1.10.56'),
  check: vi.fn(async () => ({ version: '1.10.57', url: 'u' })),
  download: vi.fn(async () => {}),
  install: vi.fn(async () => ({ started: true })),
  sync: vi.fn(async () => {}),
  ...over,
});

describe('#1 update the phone can never install', () => {
  for (const code of ['NOT_NEWER', 'WRONG_SIGNER', 'WRONG_APP', 'NOT_APK']) {
    it(`download rejected with ${code}: the wall goes away and that version is skipped`, async () => {
      const api = apiWith({
        download: vi.fn(async () => {
          throw Object.assign(new Error('Downloaded file rejected: ' + code), { code });
        }),
      });
      render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
      await waitFor(() => screen.getByTestId('update-gate'));
      fireEvent.click(screen.getByTestId('update-btn'));
      await waitFor(() => expect(screen.queryByTestId('update-gate')).toBeNull());
      expect(screen.getByText('APP')).toBeTruthy();
      expect(screen.getByTestId('update-rejected').textContent).toBe(en.updRejected);
      expect(localStorage.getItem(SKIP_KEY)).toBe('1.10.57');
    });
  }
  it('install rejected (file re-checked before the installer): same way out', async () => {
    const api = apiWith({
      install: vi.fn(async () => {
        throw Object.assign(new Error('rejected'), { code: 'WRONG_SIGNER' });
      }),
    });
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => screen.getByTestId('update-gate'));
    fireEvent.click(screen.getByTestId('update-btn'));
    await waitFor(() => expect(screen.queryByTestId('update-gate')).toBeNull());
    expect(localStorage.getItem(SKIP_KEY)).toBe('1.10.57');
  });
  it('a skipped version is not shown again; a newer one is forced normally', async () => {
    localStorage.setItem(SKIP_KEY, '1.10.57');
    const api = apiWith();
    const view = render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => expect(api.check).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('update-gate')).toBeNull();
    view.unmount();
    const api2 = apiWith({ check: vi.fn(async () => ({ version: '1.10.58', url: 'u' })) });
    render(wrap(<UpdateGate api={api2} native>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => screen.getByTestId('update-gate'));
  });
  it('a network failure is NOT permanent: the wall stays (forced update still forced)', async () => {
    const api = apiWith({
      download: vi.fn(async () => {
        throw Object.assign(new Error('Download failed'), { code: 'DOWNLOAD_FAILED' });
      }),
    });
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => screen.getByTestId('update-gate'));
    fireEvent.click(screen.getByTestId('update-btn'));
    await waitFor(() => screen.getByText(en.updFailed));
    expect(screen.getByTestId('update-gate')).toBeTruthy();
    expect(screen.getByText('APP').closest('[data-testid="update-gate-app"]').style.display).toBe('none');
    expect(screen.queryByTestId('update-later')).toBeNull(); // online: no way around it
    expect(localStorage.getItem(SKIP_KEY)).toBeNull();
  });
});

describe('#4 wall keeps the app mounted; offline way out', () => {
  it('poll finds an update while the register is being typed: the typed value survives', async () => {
    let n = 0;
    const api = apiWith({ check: vi.fn(async () => (n++ ? { version: '1.10.57', url: 'u' } : null)) });
    let unmounted = false;
    function Editor() {
      const [v, setV] = useState('3');
      useEffect(() => () => {
        unmounted = true;
      }, []);
      return <input data-testid="ed" value={v} onChange={(e) => setV(e.target.value)} />;
    }
    const view = render(wrap(<UpdateGate api={api} native pollMs={100}><Editor /></UpdateGate>));
    fireEvent.change(screen.getByTestId('ed'), { target: { value: '7' } });
    await waitFor(() => screen.getByTestId('update-gate'), { timeout: 2000 });
    expect(unmounted).toBe(false);
    expect(screen.getByTestId('ed').value).toBe('7');
    view.unmount();
  });
  it('no internet on the round: after a failed download "use the app now" lets the app be used', async () => {
    setOnline(false);
    const api = apiWith({
      download: vi.fn(async () => {
        throw Object.assign(new Error('Download failed'), { code: 'DOWNLOAD_FAILED' });
      }),
    });
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => screen.getByTestId('update-gate'));
    fireEvent.click(screen.getByTestId('update-btn'));
    const later = await screen.findByTestId('update-later');
    expect(later.textContent).toBe(en.updLater);
    fireEvent.click(later);
    expect(screen.queryByTestId('update-gate')).toBeNull();
    expect(screen.getByText('APP').closest('[data-testid="update-gate-app"]').style.display).toBe('contents');
    expect(localStorage.getItem(SKIP_KEY)).toBeNull(); // comes back with internet
  });
});

// ---------------------------------------------------------------- #14 API rate limit
describe('#14 GitHub API rate limit falls back to the github.com redirect', () => {
  const r403 = async () => ({ ok: false, status: 403, json: async () => ({}) });
  it('403 -> uses the release tag (only once its APK is uploaded)', async () => {
    const tagImpl = vi.fn(async () => ({ tag: 'v1.10.57', apk: true }));
    const u = await checkForUpdate({ current: '1.10.56', fetchImpl: r403, tagImpl });
    expect(u).toEqual({ version: '1.10.57', url: 'https://github.com/rahulyadavoxo/dairy-diary/releases/download/v1.10.57/dairy-diary-v1.10.57.apk' });
    expect(await checkForUpdate({ current: '1.10.57', fetchImpl: r403, tagImpl })).toBeNull();
    expect(await checkForUpdate({ current: '1.10.56', fetchImpl: r403, tagImpl: async () => ({ tag: 'v1.10.57', apk: false }) })).toBeNull();
    expect(await checkForUpdate({ current: '1.10.56', fetchImpl: r403, tagImpl: async () => null })).toBeNull();
  });
  it('other failures still return null without the fallback', async () => {
    const tagImpl = vi.fn();
    expect(await checkForUpdate({ current: '1.10.56', fetchImpl: async () => ({ ok: false, status: 500 }), tagImpl })).toBeNull();
    expect(tagImpl).not.toHaveBeenCalled();
    expect(releaseFromTag({ tag: 'latest', apk: true })).toBeNull();
  });
});

// ---------------------------------------------------------------- #2 / #12 Settings
const stale = { milkRatePaise: 6000, paneerRatePaise: 40000, upiId: 'old@okaxis', farmName: 'X', phone: '1' };
const renderSettings = (fb, settings, extra = {}) =>
  render(
    wrap(
      <Settings fb={fb} user={{ uid: 'u' }} settings={settings} displayName="Bhai" setDisplayName={() => {}} online={false} farm={null} farmId="f" {...extra} />,
    ),
  );

describe('#2 Settings writes only what changed', () => {
  it('changing only "my name" writes nothing to settings/main (no stale rates / UPI)', () => {
    const fb = mkFb();
    renderSettings(fb, stale);
    fireEvent.change(screen.getAllByRole('textbox').at(-1), { target: { value: 'Bhai2' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(settingsWrites(fb)).toEqual([]);
    expect(fb.authMod.updateProfile).toHaveBeenCalled();
  });
  it('changing the farm phone writes only the phone', () => {
    const fb = mkFb();
    const { container } = renderSettings(fb, stale);
    fireEvent.change(container.querySelector('input[type="tel"]'), { target: { value: '98765' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(settingsWrites(fb)).toEqual([{ path: 'farms/f/settings/main', data: { phone: '98765' } }]);
  });
  it('ring times: only the changed one is written', () => {
    const fb = mkFb();
    const { container } = renderSettings(fb, { ...stale, ringNight: '22:00', ringMorning: '08:00' });
    const [night] = container.querySelectorAll('.ring-card input[type="time"]');
    fireEvent.change(night, { target: { value: '21:30' } });
    fireEvent.click(screen.getByTestId('ring-save'));
    expect(settingsWrites(fb)).toEqual([{ path: 'farms/f/settings/main', data: { ringNight: '21:30' } }]);
  });
});

describe('#12 another phone changes a setting while typing', () => {
  it('typed rate is kept; untouched boxes follow the server', () => {
    const fb = mkFb();
    const { container, rerender } = renderSettings(fb, stale);
    const milk = () => container.querySelectorAll('input[type="number"]')[0];
    fireEvent.change(milk(), { target: { value: '65' } });
    rerender(
      wrap(
        <Settings fb={fb} user={{ uid: 'u' }} settings={{ ...stale, farmName: 'New Dairy' }} displayName="Bhai" setDisplayName={() => {}} online={false} farm={null} farmId="f" />,
      ),
    );
    expect(milk().value).toBe('65');
    expect(screen.getByDisplayValue('New Dairy')).toBeTruthy();
  });
});

describe('native #14 autostart hint', () => {
  it('ring card tells Xiaomi/Vivo/Oppo users to turn Autostart on (Hindi + English)', () => {
    renderSettings(mkFb(), stale);
    expect(screen.getByTestId('ring-autostart-hint').textContent).toContain(en.ringAutostartHint);
    expect(STRINGS.hi.ringAutostartHint).toMatch(/Autostart/);
  });
});

// ---------------------------------------------------------------- #9 history bump margin
function histFb() {
  const writes = [];
  const fsMod = {
    doc: (_db, _f, _id, coll, id) => ({ coll, id }),
    collection: (_db, _f, _id, coll) => ({ coll }),
    increment: (n) => ({ inc: n }),
    setDoc: (ref, data) => {
      writes.push({ ref, data });
      return Promise.resolve();
    },
  };
  return { fb: { farmId: 'F1', db: {}, fsMod }, bumps: () => writes.filter((w) => w.ref.id === 'history').length };
}
describe('#9 old-history bump uses a 2-day margin', () => {
  it('on the last evening of the month, an edit to the month that becomes "old" tomorrow bumps history', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 31, 23, 50)); // 31 Oct: reader phones already on 1 Nov treat August as old
    const { fb, bumps } = histFb();
    saveEntries(fb, '2026-08-15', { a: { milkL: 1 } }, 'me');
    expect(bumps()).toBe(1);
    saveEntries(fb, '2026-10-15', { a: { milkL: 1 } }, 'me');
    expect(bumps()).toBe(1);
  });
  it('mid-month the same edit is still live (no extra bump)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 15, 10, 0));
    const { fb, bumps } = histFb();
    saveEntries(fb, '2026-08-15', { a: { milkL: 1 } }, 'me');
    expect(bumps()).toBe(0);
  });
});

// ---------------------------------------------------------------- #5 memory-only cache
describe('#5 offline save broken (storage full)', () => {
  it('Firebase fallback warning is recognised and raises the event once', () => {
    expect(isMemFallbackLog({ message: 'Error using user provided cache. Falling back to memory cache: QuotaExceeded' })).toBe(true);
    expect(isMemFallbackLog({ message: 'something else' })).toBe(false);
    const h = vi.fn();
    window.addEventListener(MEMCACHE_EVENT, h);
    expect(offlineSaveBroken()).toBe(false);
    markMemCache();
    markMemCache();
    expect(offlineSaveBroken()).toBe(true);
    expect(h).toHaveBeenCalledTimes(1);
    window.removeEventListener(MEMCACHE_EVENT, h);
    expect(STRINGS.hi.storageFull).toBeTruthy();
  });
});

// ---------------------------------------------------------------- #10 / #11 PIN
describe('#11 PIN wait is capped when the clock moves back', () => {
  it('never more than 15 minutes', () => {
    localStorage.setItem('dd_pin_fails', JSON.stringify({ n: 9, until: Date.now() + 5 * 3600e3 }));
    expect(pinWaitSeconds()).toBe(900);
    localStorage.setItem('dd_pin_fails', JSON.stringify({ n: 6, until: Date.now() + 30e3 }));
    expect(pinWaitSeconds()).toBe(30);
  });
});

describe('#10 PIN gate double tap runs the action once', () => {
  it('OK pressed twice while the PIN is being checked', async () => {
    savePinHash(await hashPin('1234'));
    const onOk = vi.fn();
    function Host() {
      const gate = usePinGate();
      return (
        <>
          <button type="button" onClick={() => gate.ask('Add phone', onOk)}>
            open
          </button>
          {gate.element}
        </>
      );
    }
    render(wrap(<Host />));
    fireEvent.click(screen.getByText('open'));
    fireEvent.change(screen.getByLabelText(en.pinEnter), { target: { value: '1234' } });
    const ok = screen.getByText(en.pinGateOk);
    fireEvent.click(ok);
    fireEvent.click(ok);
    fireEvent.keyDown(screen.getByLabelText(en.pinEnter), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByTestId('pin-gate')).toBeNull(), { timeout: 5000 });
    expect(onOk).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- #13 leave offline
function farmFb() {
  let farmCb = null;
  const fsMod = {
    doc: (_db, ...path) => ({ path: path.join('/'), id: path[path.length - 1] }),
    onSnapshot: (_ref, _o, next) => {
      farmCb = next;
      return () => {};
    },
    updateDoc: vi.fn(() => new Promise(() => {})), // offline: never acknowledged
    waitForPendingWrites: vi.fn(() => new Promise(() => {})),
    deleteField: () => 'DELETE',
    terminate: vi.fn(async () => {}),
    clearIndexedDbPersistence: vi.fn(async () => {}),
  };
  const authMod = { signOut: vi.fn(async () => {}) };
  return {
    fb: { db: {}, fsMod, authMod, auth: { currentUser: null } },
    emit: (data, meta) => farmCb({ exists: () => !!data, data: () => data, metadata: { fromCache: false, hasPendingWrites: false, ...meta } }),
  };
}
describe('#13 leaving the farm offline', () => {
  it('own pending "leave": waits on the splash, never offers Sign out', () => {
    saveFarmId('p2', 'own');
    const { fb, emit } = farmFb();
    render(wrap(<Gate fb={fb} user={{ uid: 'p2', isAnonymous: true }} />));
    act(() => emit({ ownerUid: 'own', devices: { own: { name: 'Papa' } } }, { hasPendingWrites: true, fromCache: true }));
    expect(screen.queryByTestId('farm-error')).toBeNull();
    expect(screen.queryByText(en.signOut)).toBeNull();
    expect(fb.fsMod.terminate).not.toHaveBeenCalled();
  });
  it('"Remove this phone" is disabled without internet', () => {
    const { fb } = farmFb();
    const farm = { ownerUid: 'own', devices: { own: { name: 'Papa' }, p2: { name: 'Bhai' } } };
    render(wrap(<DevicesCard fb={fb} farm={farm} farmId="own" uid="p2" online={false} now={Date.now()} />));
    expect(screen.getByText(en.leaveFarm).disabled).toBe(true);
  });
  it('online: leave is disabled while it is on its way (no double leave)', async () => {
    const { fb } = farmFb();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const farm = { ownerUid: 'own', devices: { own: { name: 'Papa' }, p2: { name: 'Bhai' } } };
    render(wrap(<DevicesCard fb={fb} farm={farm} farmId="own" uid="p2" online now={Date.now()} />));
    fireEvent.click(screen.getByText(en.leaveFarm));
    await waitFor(() => expect(screen.getByText(en.leaveFarm).disabled).toBe(true));
    window.confirm.mockRestore();
  });
});
