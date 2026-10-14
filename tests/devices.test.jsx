import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import {
  generateCode,
  normalizeCode,
  cleanDeviceName,
  codeStatus,
  secondsLeft,
  deviceStatus,
  canRemove,
  listDevices,
  isOwner,
  joinFarm,
  createPairingCode,
  loadFarmId,
  saveFarmId,
  CODE_TTL_MS,
} from '../src/devices.js';
import { Gate } from '../src/App.jsx';
import DevicesCard from '../src/components/DevicesCard.jsx';
import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { hashPin, savePinHash } from '../src/pinLock.js';

const NOW = Date.UTC(2026, 9, 13, 10, 0, 0);
const farm = {
  ownerUid: 'own',
  devices: {
    own: { name: 'Papa ka phone', addedAt: NOW - 86400e3 * 3, addedBy: 'own' },
    p2: { name: 'Bhaiya ka phone', addedAt: NOW - 86400e3, addedBy: 'own', code: '123456' },
    p3: { name: 'Rahul', addedAt: NOW - 3600e3, addedBy: 'p2', code: '654321' },
  },
};

describe('pairing code helpers', () => {
  it('generates 6-digit codes, keeping leading zeros', () => {
    expect(generateCode(() => 0)).toBe('000000');
    expect(generateCode(() => 0.0000421)).toBe('000042');
    expect(generateCode(() => 0.999999999)).toBe('999999');
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^[0-9]{6}$/);
  });
  it('normalizes typed codes', () => {
    expect(normalizeCode(' 123 456 ')).toBe('123456');
    expect(normalizeCode('123-456')).toBe('123456');
    expect(normalizeCode('12345')).toBeNull();
    expect(normalizeCode('12345a')).toBeNull();
    expect(normalizeCode(null)).toBeNull();
  });
  it('validates device names', () => {
    expect(cleanDeviceName('  Papa   ka phone ')).toBe('Papa ka phone');
    expect(cleanDeviceName('   ')).toBeNull();
    expect(cleanDeviceName('x'.repeat(41))).toBeNull();
    expect(cleanDeviceName('पापा का फ़ोन')).toBe('पापा का फ़ोन');
  });
  it('code status: ok / used / expired / notFound, 10-minute expiry', () => {
    const c = { createdAt: NOW, used: false };
    expect(codeStatus(c, NOW)).toBe('ok');
    expect(codeStatus(c, NOW + CODE_TTL_MS - 1)).toBe('ok');
    expect(codeStatus(c, NOW + CODE_TTL_MS)).toBe('expired');
    expect(codeStatus({ ...c, used: true }, NOW)).toBe('used');
    expect(codeStatus(null, NOW)).toBe('notFound');
    expect(codeStatus({ used: false }, NOW)).toBe('expired'); // no timestamp yet = not usable
    // Firestore Timestamp-like values
    expect(codeStatus({ createdAt: { toMillis: () => NOW }, used: false }, NOW + 60e3)).toBe('ok');
    expect(codeStatus({ createdAt: { seconds: NOW / 1000, nanoseconds: 0 }, used: false }, NOW + 11 * 60e3)).toBe('expired');
  });
  it('seconds left counts down to 0', () => {
    expect(secondsLeft({ createdAt: NOW }, NOW)).toBe(600);
    expect(secondsLeft({ createdAt: NOW }, NOW + 599_500)).toBe(1);
    expect(secondsLeft({ createdAt: NOW }, NOW + 700_000)).toBe(0);
  });
});

describe('device status / permissions', () => {
  it('derives status from the farm snapshot', () => {
    expect(deviceStatus({ loaded: false }, 'p2')).toBe('loading');
    expect(deviceStatus({ loaded: true, exists: false }, 'own')).toBe('noFarm');
    expect(deviceStatus({ loaded: true, exists: true, farm }, 'p2')).toBe('authorized');
    expect(deviceStatus({ loaded: true, exists: true, farm }, 'gone')).toBe('removed');
    expect(deviceStatus({ loaded: true, denied: true }, 'p2')).toBe('removed');
  });
  it('only the owner removes others; never the owner device; self-removal allowed', () => {
    expect(canRemove(farm, 'own', 'p2')).toBe(true);
    expect(canRemove(farm, 'own', 'own')).toBe(false);
    expect(canRemove(farm, 'p2', 'p3')).toBe(false);
    expect(canRemove(farm, 'p2', 'own')).toBe(false);
    expect(canRemove(farm, 'p2', 'p2')).toBe(true);
    expect(canRemove(farm, 'stranger', 'p2')).toBe(false);
    expect(canRemove(farm, 'own', 'missing')).toBe(false);
    expect(isOwner(farm, 'own')).toBe(true);
    expect(isOwner(farm, 'p2')).toBe(false);
  });
  it('lists devices owner-first then by date added', () => {
    expect(listDevices(farm).map((d) => d.uid)).toEqual(['own', 'p2', 'p3']);
    expect(listDevices({ ownerUid: 'b', devices: { a: { name: 'A', addedAt: 1 }, b: { name: 'B', addedAt: 2 } } })[0].uid).toBe('b');
    expect(listDevices(null)).toEqual([]);
  });
  it('remembers the farm id per anonymous uid', () => {
    localStorage.clear();
    saveFarmId('u1', 'farmA');
    expect(loadFarmId('u1')).toBe('farmA');
    expect(loadFarmId('u2')).toBeNull();
  });
});

// ---- fake Firestore for the client flows
function fakeFb({ codes = {}, failCommit = null } = {}) {
  const writes = [];
  let farmCb = null;
  let farmErr = null;
  const fsMod = {
    doc: (_db, ...path) => ({ path: path.join('/'), id: path[path.length - 1] }),
    getDoc: async (ref) => {
      const c = codes[ref.id];
      return { exists: () => !!c, data: () => c };
    },
    setDoc: async (ref, data) => {
      writes.push(['set', ref.path, data]);
    },
    deleteDoc: async (ref) => writes.push(['delete', ref.path]),
    updateDoc: async (ref, data) => writes.push(['update', ref.path, data]),
    serverTimestamp: () => 'SERVER_TS',
    deleteField: () => 'DELETE',
    writeBatch: () => {
      const ops = [];
      return {
        update: (ref, data) => ops.push(['update', ref.path, data]),
        commit: async () => {
          if (failCommit) throw failCommit;
          writes.push(...ops);
        },
      };
    },
    onSnapshot: (ref, _o, next, err) => {
      farmCb = next;
      farmErr = err;
      return () => {};
    },
    terminate: vi.fn(async () => {}),
    clearIndexedDbPersistence: vi.fn(async () => {}),
  };
  const authMod = { signOut: vi.fn(async () => {}), updateProfile: async () => {}, signInAnonymously: vi.fn() };
  return {
    fb: { db: {}, fsMod, authMod, auth: { currentUser: null } },
    writes,
    emitFarm: (data, { fromCache = false } = {}) =>
      farmCb({ exists: () => !!data, data: () => data, metadata: { fromCache } }),
    denyFarm: () => farmErr({ code: 'permission-denied' }),
  };
}

describe('joinFarm / createPairingCode (client logic)', () => {
  it('joins with a valid code: consumes the code and adds only itself, atomically', async () => {
    const { fb, writes } = fakeFb({ codes: { '123456': { farmId: 'own', createdBy: 'own', createdAt: NOW - 60e3, used: false } } });
    const farmId = await joinFarm(fb, 'newUid', '123 456', ' Bhaiya ', NOW);
    expect(farmId).toBe('own');
    expect(writes).toEqual([
      ['update', 'pairingCodes/123456', { used: true, usedBy: 'newUid', usedAt: 'SERVER_TS' }],
      ['update', 'farms/own', { 'devices.newUid': { name: 'Bhaiya', addedAt: 'SERVER_TS', addedBy: 'own', code: '123456' } }],
    ]);
  });
  it('rejects expired, used, unknown codes and bad input without writing', async () => {
    const { fb, writes } = fakeFb({
      codes: {
        '111111': { farmId: 'own', createdBy: 'own', createdAt: NOW - CODE_TTL_MS - 1, used: false },
        '222222': { farmId: 'own', createdBy: 'own', createdAt: NOW, used: true },
      },
    });
    await expect(joinFarm(fb, 'u', '111111', 'x', NOW)).rejects.toMatchObject({ reason: 'expired' });
    await expect(joinFarm(fb, 'u', '222222', 'x', NOW)).rejects.toMatchObject({ reason: 'used' });
    await expect(joinFarm(fb, 'u', '333333', 'x', NOW)).rejects.toMatchObject({ reason: 'notFound' });
    await expect(joinFarm(fb, 'u', '12', 'x', NOW)).rejects.toMatchObject({ reason: 'invalidCode' });
    await expect(joinFarm(fb, 'u', '111111', '  ', NOW)).rejects.toMatchObject({ reason: 'invalidName' });
    expect(writes).toEqual([]);
  });
  it('maps a server permission-denied (e.g. code raced/used) to "denied"', async () => {
    const { fb } = fakeFb({
      codes: { '123456': { farmId: 'own', createdBy: 'own', createdAt: NOW, used: false } },
      failCommit: { code: 'permission-denied' },
    });
    await expect(joinFarm(fb, 'u', '123456', 'x', NOW)).rejects.toMatchObject({ reason: 'denied' });
  });
  it('creates a code with a server timestamp, skipping codes that already exist', async () => {
    const { fb, writes } = fakeFb({ codes: { '000000': { used: true } } });
    const seq = [0, 0.5];
    const code = await createPairingCode(fb, 'own', 'p2', () => seq.shift());
    expect(code).toBe('500000');
    expect(writes).toEqual([['set', 'pairingCodes/500000', { farmId: 'own', createdBy: 'p2', createdAt: 'SERVER_TS', used: false }]]);
  });
});

// ---- UI
function withLang(ui, lang = 'hi') {
  return <LangContext.Provider value={{ lang, t: makeT(lang), setLang: () => {} }}>{ui}</LangContext.Provider>;
}

describe('Gate screens', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });
  it('no user: Welcome → Join screen (Hindi default)', () => {
    const { fb } = fakeFb();
    render(withLang(<Gate fb={fb} user={null} />));
    expect(screen.getByTestId('welcome')).toBeTruthy();
    fireEvent.click(screen.getByText(STRINGS.hi.welcomeJoin));
    expect(screen.getByTestId('join-farm')).toBeTruthy();
    fireEvent.click(screen.getByText(STRINGS.hi.back));
    fireEvent.click(screen.getByText(STRINGS.hi.welcomeOwner));
    expect(screen.getByTestId('login')).toBeTruthy();
  });
  it('join screen shows the expired-code error in English', async () => {
    const { fb } = fakeFb({ codes: { '111111': { farmId: 'own', createdBy: 'own', createdAt: Date.now() - CODE_TTL_MS - 5, used: false } } });
    render(withLang(<Gate fb={fb} user={{ uid: 'anon1', isAnonymous: true }} />, 'en'));
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '111111' } });
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en.deviceNamePlaceholder), { target: { value: 'Rahul' } });
    fireEvent.click(screen.getByText(STRINGS.en.joinButton));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(STRINGS.en.errExpired));
  });
  it('owner without a farm sees the setup screen (only after the server confirms)', async () => {
    const { fb, emitFarm } = fakeFb();
    render(withLang(<Gate fb={fb} user={{ uid: 'own', email: 'o@x.in', isAnonymous: false }} />));
    act(() => emitFarm(null, { fromCache: true })); // cache-only miss is not proof
    expect(screen.queryByTestId('setup-farm')).toBeNull();
    act(() => emitFarm(null));
    expect(screen.getByTestId('setup-farm')).toBeTruthy();
  });
  it('removed phone: wipes local cache, signs out, and shows the lock screen', async () => {
    saveFarmId('p2', 'own');
    const { fb, emitFarm } = fakeFb();
    const view = render(withLang(<Gate fb={fb} user={{ uid: 'p2', isAnonymous: true }} />));
    act(() => emitFarm({ ownerUid: 'own', devices: { own: { name: 'Papa' } } })); // p2 not in devices
    await waitFor(() => expect(screen.getByTestId('removed')).toBeTruthy());
    expect(fb.fsMod.terminate).toHaveBeenCalled();
    expect(fb.fsMod.clearIndexedDbPersistence).toHaveBeenCalled();
    expect(fb.authMod.signOut).toHaveBeenCalled();
    expect(loadFarmId('p2')).toBeNull();
    expect(screen.getByText(STRINGS.hi.removedTitle)).toBeTruthy();
    // lock persists across a restart (signed out now)
    view.unmount();
    render(withLang(<Gate fb={fb} user={null} />, 'en'));
    expect(screen.getByText(STRINGS.en.removedTitle)).toBeTruthy();
  });
  it('permission-denied on the farm doc also locks an anonymous phone', async () => {
    saveFarmId('p2', 'own');
    const { fb, denyFarm } = fakeFb();
    render(withLang(<Gate fb={fb} user={{ uid: 'p2', isAnonymous: true }} />));
    act(() => denyFarm());
    await waitFor(() => expect(screen.getByTestId('removed')).toBeTruthy());
  });
  it('permission-denied for the OWNER shows a rules/OWNER_EMAIL hint, never wipes', async () => {
    const { fb, denyFarm } = fakeFb();
    render(withLang(<Gate fb={fb} user={{ uid: 'own', email: 'o@x.in', isAnonymous: false }} />, 'en'));
    act(() => denyFarm());
    expect(screen.getByTestId('farm-error').textContent).toContain(STRINGS.en.farmCheckFailed);
    expect(fb.fsMod.terminate).not.toHaveBeenCalled();
  });
});

describe('Settings → Phones card', () => {
  beforeEach(() => cleanup());
  it('owner sees all phones and a Remove button on every non-owner phone', () => {
    const { fb } = fakeFb();
    render(withLang(<DevicesCard fb={fb} farm={farm} farmId="own" uid="own" online now={NOW} />, 'en'));
    expect(screen.getAllByTestId('device-row')).toHaveLength(3);
    expect(screen.getAllByText(STRINGS.en.removeDevice)).toHaveLength(2);
    expect(screen.getByText(STRINGS.en.ownerBadge)).toBeTruthy();
    expect(screen.queryByText(STRINGS.en.leaveFarm)).toBeNull();
  });
  it('non-owner sees no Remove buttons for others, only "remove this phone"', () => {
    const { fb } = fakeFb();
    render(withLang(<DevicesCard fb={fb} farm={farm} farmId="own" uid="p2" online now={NOW} />));
    expect(screen.queryAllByText(STRINGS.hi.removeDevice)).toHaveLength(0);
    expect(screen.getByText(STRINGS.hi.leaveFarm)).toBeTruthy();
  });
  it('owner removing a phone writes a deleteField for that uid only', () => {
    const { fb, writes } = fakeFb();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(withLang(<DevicesCard fb={fb} farm={farm} farmId="own" uid="own" online now={NOW} />, 'en'));
    fireEvent.click(screen.getAllByText(STRINGS.en.removeDevice)[0]);
    expect(writes).toEqual([['update', 'farms/own', { 'devices.p2': 'DELETE' }]]);
  });
  it('"Add phone" shows a 6-digit code with a countdown, and "Phone added" once used', async () => {
    const { fb } = fakeFb();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(withLang(<DevicesCard fb={fb} farm={farm} farmId="own" uid="own" online />, 'en'));
    fireEvent.click(screen.getByText('➕ ' + STRINGS.en.addPhone));
    const codeEl = await screen.findByTestId('pairing-code');
    expect(codeEl.textContent.replace(' ', '')).toMatch(/^[0-9]{6}$/);
    expect(screen.getByText(/10:00|9:5\d/)).toBeTruthy();
    const code = codeEl.textContent.replace(' ', '');
    const joined = { ...farm, devices: { ...farm.devices, p9: { name: 'Naya phone', addedAt: Date.now(), addedBy: 'own', code } } };
    view.rerender(withLang(<DevicesCard fb={fb} farm={joined} farmId="own" uid="own" online />, 'en'));
    expect(screen.getByText(new RegExp(STRINGS.en.codeUsed))).toBeTruthy();
  });
  it('Add phone is disabled offline', () => {
    const { fb } = fakeFb();
    render(withLang(<DevicesCard fb={fb} farm={farm} farmId="own" uid="own" online={false} now={NOW} />));
    expect(screen.getByText('➕ ' + STRINGS.hi.addPhone).disabled).toBe(true);
  });
});

describe('1.10.15: adding / removing a phone needs the PIN', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });
  it('no PIN set: Remove asks a confirm; No = nothing removed', () => {
    const { fb, writes } = fakeFb();
    const c = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(withLang(<DevicesCard fb={fb} farm={farm} farmId="own" uid="own" online now={NOW} />, 'en'));
    fireEvent.click(screen.getAllByText(STRINGS.en.removeDevice)[0]);
    expect(c).toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  it('PIN set: Remove opens the PIN box; wrong PIN removes nothing, right PIN removes', async () => {
    savePinHash(await hashPin('4321'));
    const { fb, writes } = fakeFb();
    const c = vi.spyOn(window, 'confirm');
    render(withLang(<DevicesCard fb={fb} farm={farm} farmId="own" uid="own" online now={NOW} />, 'en'));
    fireEvent.click(screen.getAllByText(STRINGS.en.removeDevice)[0]);
    expect(c).not.toHaveBeenCalled();
    expect(screen.getByTestId('pin-gate')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(STRINGS.en.pinEnter), { target: { value: '1111' } });
    fireEvent.click(screen.getByText(STRINGS.en.pinGateOk));
    await screen.findByText(STRINGS.en.pinWrong);
    expect(writes).toEqual([]);
    fireEvent.change(screen.getByLabelText(STRINGS.en.pinEnter), { target: { value: '4321' } });
    fireEvent.click(screen.getByText(STRINGS.en.pinGateOk));
    await waitFor(() => expect(writes).toEqual([['update', 'farms/own', { 'devices.p2': 'DELETE' }]]));
    expect(screen.queryByTestId('pin-gate')).toBeNull();
  });
  it('PIN set: Add phone shows no code until the PIN is right', async () => {
    savePinHash(await hashPin('4321'));
    const { fb } = fakeFb();
    render(withLang(<DevicesCard fb={fb} farm={farm} farmId="own" uid="own" online />, 'en'));
    fireEvent.click(screen.getByText('➕ ' + STRINGS.en.addPhone));
    expect(screen.getByText(STRINGS.en.pinForAddPhone, { exact: false })).toBeTruthy();
    expect(screen.queryByTestId('pairing-code')).toBeNull();
    fireEvent.change(screen.getByLabelText(STRINGS.en.pinEnter), { target: { value: '4321' } });
    fireEvent.click(screen.getByText(STRINGS.en.pinGateOk));
    expect(await screen.findByTestId('pairing-code')).toBeTruthy();
  });
});
