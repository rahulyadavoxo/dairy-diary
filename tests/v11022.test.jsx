import { describe, it, expect } from 'vitest';
import { entryChanges } from '../src/db.js';
import { entryCharge } from '../src/billing.js';

describe('1.10.22 two phones / offline phone never overwrite each other', () => {
  it('only fields the user changed are sent; empty values count as the same', () => {
    expect(entryChanges({ milkMorningL: 1, milkEveningL: 0, note: '' }, { milkMorningL: 1, milkEveningL: 1, note: '' })).toEqual({ milkEveningL: 1 });
    expect(entryChanges(undefined, { milkMorningL: 1, milkEveningL: 0, skip: false, note: '', milkRatePaise: null })).toEqual({ milkMorningL: 1 });
    expect(entryChanges(undefined, { milkL: 0, milkMorningL: 0, skip: false })).toEqual({ milkL: 0 });
    expect(entryChanges({ milkL: 2 }, { milkL: 2 })).toEqual({});
    expect(entryChanges({ active: true }, { active: false })).toEqual({ active: false });
  });
  it('offline morning write + other phone evening write => both kept, bill uses morning + evening', () => {
    // phone A offline at 07:00 sends only what it changed
    const a = entryChanges(undefined, { milkMorningL: 1, milkEveningL: 0, milkL: 1, milkRatePaise: 6000 });
    // phone B at 19:00 (online) sets evening on top of what it saw (nothing yet)
    const b = entryChanges(undefined, { milkMorningL: 0, milkEveningL: 1, milkL: 1, milkRatePaise: 6000 });
    const server = { ...b, ...a }; // A's queued write lands last
    expect(server.milkMorningL).toBe(1);
    expect(server.milkEveningL).toBe(1);
    expect(entryCharge(server, { id: 'c' }, {}).milkMl).toBe(2000);
  });
  it('a total-only entry still bills its total', () => {
    expect(entryCharge({ milkL: 3, milkMorningL: 0, milkEveningL: 0, milkRatePaise: 6000 }, { id: 'c' }, {}).milkMl).toBe(3000);
  });
});

import { hashPin, verifyPin, savePinHash, getPinHash, sha256Hex } from '../src/pinLock.js';
describe('1.10.22 PIN hash is salted PBKDF2; old PINs still work and get upgraded', () => {
  it('new PIN', async () => {
    const h = await hashPin('1234');
    expect(h).toMatch(/^v2\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(await hashPin('1234')).not.toBe(h); // random salt
    savePinHash(h);
    expect(await verifyPin('9999')).toBe(false);
    expect(await verifyPin('1234')).toBe(true);
    savePinHash('');
  });
  it('old v1 hash still unlocks and is upgraded', async () => {
    savePinHash(await sha256Hex('dd-pin:4321'));
    expect(await verifyPin('4321')).toBe(true);
    expect(getPinHash()).toMatch(/^v2\$/);
    expect(await verifyPin('4321')).toBe(true);
    savePinHash('');
  });
});

import { readFileSync, existsSync } from 'node:fs';
describe('1.10.22 release hardening', () => {
  it('release build, no WebView debugging, no backup, no service worker, narrow FileProvider', () => {
    const wf = readFileSync('.github/workflows/android.yml', 'utf8');
    expect(wf).toContain('assembleRelease');
    expect(wf).toMatch(/permissions:\n  contents: read/);
    const g = readFileSync('android/app/build.gradle', 'utf8');
    expect(g).toContain('debuggable false');
    expect(JSON.parse(readFileSync('capacitor.config.json', 'utf8')).android.webContentsDebuggingEnabled).toBe(false);
    const m = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
    expect(m).toContain('android:allowBackup="false"');
    expect(existsSync('public/sw.js')).toBe(false);
    expect(readFileSync('index.html', 'utf8')).toContain('r.unregister()');
    expect(readFileSync('android/app/src/main/res/xml/file_paths.xml', 'utf8')).not.toContain('external-path');
  });
});

import { saveEntries } from '../src/db.js';
describe('1.10.23 a new 0 L entry is still created (calendar ✕, day counts as filled)', () => {
  const mk = () => {
    const writes = [];
    const fb = {
      farmId: 'f',
      db: {},
      fsMod: {
        doc: (...a) => a.slice(1).join('/'),
        collection: (...a) => a.slice(1).join('/'),
        setDoc: (ref, data) => (writes.push({ ref, data }), Promise.resolve()),
      },
    };
    return { fb, writes };
  };
  it('new 0 L row -> entry written; unchanged existing row -> nothing written', () => {
    const { fb, writes } = mk();
    saveEntries(fb, '2026-10-07', { c1: { milkL: 0, milkMorningL: 0, milkEveningL: 0, skip: false, note: '' } }, 'x', {});
    expect(writes.length).toBe(1);
    expect(writes[0].data.entries.c1).toBeTruthy();
    expect(writes[0].data.entries.c1.milkL).toBe(0); // 1.10.33: a new 0 L entry stores milkL 0
    saveEntries(fb, '2026-10-07', { c1: { milkL: 1 } }, 'x', { c1: { milkL: 1 } });
    expect(writes.length).toBe(1);
  });
});
