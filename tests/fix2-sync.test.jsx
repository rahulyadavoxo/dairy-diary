// Regression tests for the 1.10.59 re-check (recheck/sync.txt N1-N7).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';

// Capacitor App plugin: listeners kept here so tests can fire 'appStateChange' / 'resume'.
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
    },
  };
});
vi.mock('@capacitor/app', () => ({ App: capApp.App }));
vi.mock('../src/feedback.js', () => ({ playSound: () => {}, vibrateFail: () => {}, saveFeedback: (ok) => ok }));
const batt = vi.hoisted(() => ({ value: false }));
vi.mock('../src/reminders.js', async (orig) => ({
  ...(await orig()),
  batteryExempt: vi.fn(async () => batt.value),
  ringPermission: vi.fn(async () => 'granted'),
}));

import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import Settings from '../src/screens/Settings.jsx';
import UpdateGate, { SKIP_KEY, SKIP_MS } from '../src/components/UpdateGate.jsx';
import { pinWaitSeconds } from '../src/pinLock.js';
import { pushBackHandler, handleBack } from '../src/backStack.js';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;

let errSpy = null;
beforeEach(() => {
  cleanup();
  localStorage.clear();
  for (const k of Object.keys(capApp.ls)) delete capApp.ls[k];
  capApp.App.minimizeApp.mockClear();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  vi.useRealTimers();
});

const resume = () => act(async () => capApp.fire('appStateChange', { isActive: true }));
const apiWith = (over = {}) => ({
  current: vi.fn(async () => '1.10.59'),
  check: vi.fn(async () => ({ version: '1.10.60', url: 'u' })),
  download: vi.fn(async () => {}),
  install: vi.fn(async () => ({ started: true })),
  sync: vi.fn(async () => {}),
  ...over,
});
const failWith = (code) =>
  vi.fn(async () => {
    throw Object.assign(new Error('x ' + code), { code });
  });

// ---------------------------------------------------------------- N1
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
const settingsWrites = (fb) => fb.writes.filter((x) => x.path === 'farms/f/settings/main').map((x) => x.data);
const S = (fb, settings) => (
  <Settings fb={fb} user={{ uid: 'u' }} settings={settings} displayName="Bhai" setDisplayName={() => {}} online={false} farm={null} farmId="f" />
);

describe('N1 rate boxes compare by value', () => {
  it('"60.50" saved, another phone sets 62, then a name-only save does NOT resend 60.50', async () => {
    const fb = mkFb();
    const base = { milkRatePaise: 6000, paneerRatePaise: 40000, farmName: 'X', phone: '1', upiId: '' };
    const { container, rerender } = render(wrap(S(fb, base)));
    const milk = () => container.querySelectorAll('input[type="number"]')[0];
    fireEvent.change(milk(), { target: { value: '60.50' } });
    // rate change needs the PIN only when a PIN is set (none here) -> saves directly
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(settingsWrites(fb)).toEqual([{ milkRatePaise: 6050 }]);
    expect(milk().value).toBe('60.5'); // normalised after save
    rerender(wrap(S(fb, { ...base, milkRatePaise: 6050 })));
    expect(screen.getByTestId('settings-save').className).toContain('saved-btn');
    rerender(wrap(S(fb, { ...base, milkRatePaise: 6200 }))); // other phone
    expect(milk().value).toBe('62');
    fireEvent.change(screen.getAllByRole('textbox').at(-1), { target: { value: 'Bhai2' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(settingsWrites(fb)).toEqual([{ milkRatePaise: 6050 }]); // nothing new
  });
  it('an untouched box with the same value written differently still follows the server', () => {
    const fb = mkFb();
    const base = { milkRatePaise: 6000, paneerRatePaise: 40000, farmName: 'X', phone: '1', upiId: '' };
    const { container, rerender } = render(wrap(S(fb, base)));
    const milk = () => container.querySelectorAll('input[type="number"]')[0];
    fireEvent.change(milk(), { target: { value: '60.0' } }); // same rate, other text
    expect(screen.getByTestId('settings-save').className).toContain('saved-btn'); // not dirty
    rerender(wrap(S(fb, { ...base, milkRatePaise: 6200 })));
    expect(milk().value).toBe('62');
  });
  it('a really typed rate is still kept when the server changes', () => {
    const fb = mkFb();
    const base = { milkRatePaise: 6000, paneerRatePaise: 40000, farmName: 'X', phone: '1', upiId: '' };
    const { container, rerender } = render(wrap(S(fb, base)));
    const milk = () => container.querySelectorAll('input[type="number"]')[0];
    fireEvent.change(milk(), { target: { value: '65' } });
    rerender(wrap(S(fb, { ...base, milkRatePaise: 6200 })));
    expect(milk().value).toBe('65');
  });
  it('trailing spaces in name are trimmed in the box after save (box follows later changes)', () => {
    const fb = mkFb();
    const base = { milkRatePaise: 6000, paneerRatePaise: 40000, farmName: 'X', phone: '1', upiId: '' };
    const { rerender } = render(wrap(S(fb, base)));
    fireEvent.change(screen.getByDisplayValue('X'), { target: { value: 'Y ' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(settingsWrites(fb)).toEqual([{ farmName: 'Y' }]);
    rerender(wrap(S(fb, { ...base, farmName: 'Y' })));
    rerender(wrap(S(fb, { ...base, farmName: 'Z' })));
    expect(screen.getByDisplayValue('Z')).toBeTruthy();
  });
});

// ---------------------------------------------------------------- N7
describe('N7 battery warning re-checked on Capacitor resume', () => {
  it('after the exemption dialog (no visibilitychange) the warning goes on resume', async () => {
    batt.value = false;
    render(wrap(S(mkFb(), { milkRatePaise: 6000, paneerRatePaise: 40000 })));
    await screen.findByTestId('ring-battery-off');
    await waitFor(() => expect(capApp.ls.resume && capApp.ls.resume.length).toBe(1));
    batt.value = true;
    await act(async () => capApp.fire('resume'));
    await waitFor(() => expect(screen.queryByTestId('ring-battery-off')).toBeNull());
  });
  it('listener removed on unmount', async () => {
    const v = render(wrap(S(mkFb(), { milkRatePaise: 6000, paneerRatePaise: 40000 })));
    await waitFor(() => expect(capApp.ls.resume && capApp.ls.resume.length).toBe(1));
    v.unmount();
    expect(capApp.ls.resume.length).toBe(0);
  });
});

// ---------------------------------------------------------------- N2
describe('N2 update found while the app is in use waits for the next resume', () => {
  it('poll hit is held; the register stays usable; resume locks it (forced)', async () => {
    let n = 0;
    const api = apiWith({ check: vi.fn(async () => (n++ ? { version: '1.10.60', url: 'u' } : null)) });
    render(wrap(<UpdateGate api={api} native pollMs={40}>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => expect(api.check.mock.calls.length).toBeGreaterThan(2));
    expect(screen.queryByTestId('update-gate')).toBeNull();
    expect(api.sync).not.toHaveBeenCalled();
    await resume();
    await screen.findByTestId('update-gate');
    expect(api.sync).toHaveBeenCalled();
  });
  it('internet coming back: held as well, then resume locks even if that check fails', async () => {
    let res = null;
    const api = apiWith({ check: vi.fn(async () => res) });
    render(wrap(<UpdateGate api={api} native pollMs={1e9}>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => expect(api.check).toHaveBeenCalledTimes(1));
    res = { version: '1.10.60', url: 'u' };
    await act(async () => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(api.check).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('update-gate')).toBeNull();
    res = null; // GitHub unreachable at resume: the held update still locks
    await resume();
    await screen.findByTestId('update-gate');
  });
  it('app start still locks at once', async () => {
    render(wrap(<UpdateGate api={apiWith()} native>{<p>APP</p>}</UpdateGate>));
    await screen.findByTestId('update-gate');
  });
});

// ---------------------------------------------------------------- N3
describe('N3 skip expires; NOT_APK needs 2 failures', () => {
  it('a skip older than 12 h is forced again; a fresh one is skipped', async () => {
    localStorage.setItem(SKIP_KEY, JSON.stringify({ v: '1.10.60', at: Date.now() - SKIP_MS - 1000 }));
    const v = render(wrap(<UpdateGate api={apiWith()} native>{<p>APP</p>}</UpdateGate>));
    await screen.findByTestId('update-gate');
    v.unmount();
    localStorage.setItem(SKIP_KEY, JSON.stringify({ v: '1.10.60', at: Date.now() - 1000 }));
    const api = apiWith();
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => expect(api.check).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('update-gate')).toBeNull();
  });
  it('an old plain-string skip (no time) is treated as expired', async () => {
    localStorage.setItem(SKIP_KEY, '1.10.60');
    render(wrap(<UpdateGate api={apiWith()} native>{<p>APP</p>}</UpdateGate>));
    await screen.findByTestId('update-gate');
  });
  it('first NOT_APK = normal error with Retry; second = give up for 12 h', async () => {
    const api = apiWith({ download: failWith('NOT_APK') });
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    fireEvent.click(await screen.findByTestId('update-btn'));
    await screen.findByText(en.updFailed);
    expect(screen.getByTestId('update-btn').textContent).toBe(en.updRetry);
    expect(localStorage.getItem(SKIP_KEY)).toBeNull();
    fireEvent.click(screen.getByTestId('update-btn'));
    await waitFor(() => expect(screen.queryByTestId('update-gate')).toBeNull());
    const s = JSON.parse(localStorage.getItem(SKIP_KEY));
    expect(s.v).toBe('1.10.60');
    expect(Date.now() - s.at).toBeLessThan(5000);
  });
  it('other permanent codes still give up at once', async () => {
    const api = apiWith({ download: failWith('WRONG_SIGNER') });
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    fireEvent.click(await screen.findByTestId('update-btn'));
    await waitFor(() => expect(screen.queryByTestId('update-gate')).toBeNull());
  });
  it('native: a download without a size header that is tiny counts as incomplete', () => {
    const j = readFileSync('android/app/src/main/java/in/dairydiary/app/ApkUpdaterPlugin.java', 'utf8');
    expect(j).toContain('static final long MIN_APK_BYTES = 1024L * 1024L;');
    expect(j).toMatch(/if \(total <= 0 && done < MIN_APK_BYTES\) throw new Exception\("incomplete \(no length\)"\);/);
    // the size check comes before the file is renamed and checked as an APK
    expect(j.indexOf('done < MIN_APK_BYTES')).toBeLessThan(j.indexOf('String bad = checkApk(out);'));
  });
});

// ---------------------------------------------------------------- N4
describe('N4 "Use the app now" after 2 failed tries even when "online"', () => {
  it('online, 1 failure: no way out; 2 failures: way out; the update comes back on resume', async () => {
    const api = apiWith({ download: failWith('DOWNLOAD_FAILED') });
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    fireEvent.click(await screen.findByTestId('update-btn'));
    await screen.findByText(en.updFailed);
    expect(screen.queryByTestId('update-later')).toBeNull();
    fireEvent.click(screen.getByTestId('update-btn'));
    const later = await screen.findByTestId('update-later');
    expect(later.closest('label')).toBeNull();
    fireEvent.click(later);
    expect(screen.queryByTestId('update-gate')).toBeNull();
    expect(screen.getByText('APP').closest('[data-testid="update-gate-app"]').style.display).toBe('contents');
    // forced again: the next resume (after the 1-min throttle) brings the wall back, fresh try count
    const t0 = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => t0 + 2 * 60e3);
    await resume();
    spy.mockRestore();
    await screen.findByTestId('update-gate');
    expect(screen.queryByTestId('update-later')).toBeNull();
  });
  it('failed installs count too', async () => {
    const api = apiWith({ install: failWith('NO_FILE') });
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    fireEvent.click(await screen.findByTestId('update-btn'));
    await screen.findByText(en.updFailed);
    fireEvent.click(screen.getByTestId('update-btn'));
    await screen.findByTestId('update-later');
  });
});

// ---------------------------------------------------------------- N5
describe('N5 Back button while the Update screen is up', () => {
  it('the wall owns Back: the hidden app handler does not run; the app is minimised', async () => {
    const hidden = vi.fn();
    const off = pushBackHandler(hidden);
    const v = render(wrap(<UpdateGate api={apiWith()} native>{<p>APP</p>}</UpdateGate>));
    await screen.findByTestId('update-gate');
    expect(handleBack()).toBe(true);
    expect(handleBack()).toBe(true); // every press, not just the first
    expect(hidden).not.toHaveBeenCalled();
    await waitFor(() => expect(capApp.App.minimizeApp).toHaveBeenCalledTimes(2));
    v.unmount();
    // wall gone: Back works for the app again
    expect(handleBack()).toBe(true);
    expect(hidden).toHaveBeenCalledTimes(1);
    off();
  });
  it('after "Use the app now" Back goes to the app again', async () => {
    const hidden = vi.fn();
    const off = pushBackHandler(hidden);
    render(wrap(<UpdateGate api={apiWith({ download: failWith('DOWNLOAD_FAILED') })} native>{<p>APP</p>}</UpdateGate>));
    fireEvent.click(await screen.findByTestId('update-btn'));
    await screen.findByText(en.updFailed);
    fireEvent.click(screen.getByTestId('update-btn'));
    fireEvent.click(await screen.findByTestId('update-later'));
    handleBack();
    expect(hidden).toHaveBeenCalledTimes(1);
    off();
  });
});

// ---------------------------------------------------------------- N6
describe('N6 PIN wait after a big clock jump back counts down', () => {
  it('lock end is pulled in to now+15 min and saved', () => {
    const now = Date.now();
    localStorage.setItem('dd_pin_fails', JSON.stringify({ n: 9, until: now + 24 * 3600e3 }));
    expect(pinWaitSeconds(now)).toBe(900);
    expect(JSON.parse(localStorage.getItem('dd_pin_fails'))).toEqual({ n: 9, until: now + 900e3 });
    expect(pinWaitSeconds(now + 20 * 60e3)).toBe(0);
    localStorage.setItem('dd_pin_fails', JSON.stringify({ n: 9, until: now + 24 * 3600e3 }));
    expect(pinWaitSeconds(now)).toBe(900);
    expect(pinWaitSeconds(now + 5 * 60e3)).toBe(600);
  });
  it('a normal wait is not rewritten', () => {
    const now = Date.now();
    const raw = JSON.stringify({ n: 6, until: now + 30e3 });
    localStorage.setItem('dd_pin_fails', raw);
    expect(pinWaitSeconds(now)).toBe(30);
    expect(localStorage.getItem('dd_pin_fails')).toBe(raw);
  });
});
