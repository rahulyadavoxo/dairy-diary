import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { parseVer, cmpVer, pickRelease, checkForUpdate, LATEST_URL } from '../src/appUpdate.js';
import UpdateGate from '../src/components/UpdateGate.jsx';
import { readFileSync } from 'node:fs';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
const rel = (tag, assets = [`dairy-diary-${tag}.apk`]) => ({ tag_name: tag, draft: false, prerelease: false, assets: assets.map((name) => ({ name, state: 'uploaded' })) });
const okFetch = (json) => vi.fn(async () => ({ ok: true, json: async () => json }));

describe('appUpdate helpers', () => {
  it('parses and compares versions numerically', () => {
    expect(parseVer('v1.10.16')).toEqual([1, 10, 16]);
    expect(parseVer('1.2')).toBeNull();
    expect(cmpVer('1.10.16', '1.10.15')).toBeGreaterThan(0);
    expect(cmpVer('1.10.9', '1.10.15')).toBeLessThan(0);
    expect(cmpVer('1.11.0', '1.10.99')).toBeGreaterThan(0);
    expect(cmpVer('1.10.15', 'v1.10.15')).toBe(0);
    expect(cmpVer('x', '1.0.0')).toBeNull();
  });
  it('pickRelease needs the matching APK asset already uploaded', () => {
    expect(pickRelease(rel('v1.10.16'))).toEqual({
      version: '1.10.16',
      url: 'https://github.com/rahulyadavoxo/dairy-diary/releases/download/v1.10.16/dairy-diary-v1.10.16.apk',
    });
    expect(pickRelease(rel('v1.10.16', []))).toBeNull(); // release made, APK not uploaded yet
    expect(pickRelease(rel('v1.10.16', ['dairy-diary-v1.10.15.apk']))).toBeNull();
    expect(pickRelease({ ...rel('v1.10.16'), prerelease: true })).toBeNull();
    expect(pickRelease({ ...rel('v1.10.16'), draft: true })).toBeNull();
    expect(pickRelease(rel('nightly'))).toBeNull();
    expect(pickRelease(null)).toBeNull();
  });
  it('checkForUpdate: newer -> update, same/older -> null, errors -> null (never blocks)', async () => {
    const f = okFetch(rel('v1.10.17'));
    expect(await checkForUpdate({ current: '1.10.16', fetchImpl: f })).toMatchObject({ version: '1.10.17' });
    expect(f.mock.calls[0][0]).toBe(LATEST_URL);
    expect(await checkForUpdate({ current: '1.10.17', fetchImpl: okFetch(rel('v1.10.17')) })).toBeNull();
    expect(await checkForUpdate({ current: '1.10.18', fetchImpl: okFetch(rel('v1.10.17')) })).toBeNull();
    expect(await checkForUpdate({ current: '1.10.16', fetchImpl: vi.fn(async () => ({ ok: false, status: 403 })) })).toBeNull();
    expect(await checkForUpdate({ current: '1.10.16', fetchImpl: vi.fn(async () => { throw new Error('offline'); }) })).toBeNull();
    expect(await checkForUpdate({ current: null, fetchImpl: f })).toBeNull();
  });
});

describe('UpdateGate', () => {
  beforeEach(() => cleanup());
  const U = { version: '1.10.17', url: 'https://github.com/rahulyadavoxo/dairy-diary/releases/download/v1.10.17/dairy-diary-v1.10.17.apk' };
  const mkApi = (over = {}) => ({
    current: vi.fn(async () => '1.10.16'),
    check: vi.fn(async () => U),
    download: vi.fn(async (url, onPct) => {
      onPct(50);
      onPct(100);
      return { size: 1 };
    }),
    install: vi.fn(async () => ({ started: true })),
    sync: vi.fn(async () => {}),
    ...over,
  });

  it('no update -> the app shows normally', async () => {
    const api = mkApi({ check: vi.fn(async () => null) });
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => expect(api.check).toHaveBeenCalled());
    expect(screen.getByText('APP')).toBeTruthy();
    expect(screen.queryByTestId('update-gate')).toBeNull();
  });
  it('web build never checks', async () => {
    const api = mkApi();
    render(wrap(<UpdateGate api={api} native={false}>{<p>APP</p>}</UpdateGate>));
    await Promise.resolve();
    expect(api.current).not.toHaveBeenCalled();
    expect(screen.getByText('APP')).toBeTruthy();
  });
  it('newer version -> app hidden behind the Update screen; Update downloads then installs', async () => {
    const api = mkApi();
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    expect(await screen.findByTestId('update-gate')).toBeTruthy();
    expect(screen.queryByText('APP')).toBeNull();
    expect(screen.getByText(en.updBody.replace('{v}', '1.10.17'))).toBeTruthy();
    fireEvent.click(screen.getByTestId('update-btn'));
    await waitFor(() => expect(api.install).toHaveBeenCalledTimes(1));
    expect(api.download).toHaveBeenCalledWith(U.url, expect.any(Function));
    expect(await screen.findByText(en.updInstallHint)).toBeTruthy();
    // tapping again (installer closed) re-opens the installer without downloading again
    fireEvent.click(screen.getByTestId('update-btn'));
    await waitFor(() => expect(api.install).toHaveBeenCalledTimes(2));
    expect(api.download).toHaveBeenCalledTimes(1);
  });
  it('install permission missing -> explains how to allow it', async () => {
    const api = mkApi({ install: vi.fn(async () => ({ needsPermission: true })) });
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    fireEvent.click(await screen.findByTestId('update-btn'));
    expect(await screen.findByText(en.updPermHint)).toBeTruthy();
  });
  it('download failure -> error and Try again; the app stays locked', async () => {
    const api = mkApi({ download: vi.fn(async () => { throw new Error('net'); }) });
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    fireEvent.click(await screen.findByTestId('update-btn'));
    expect(await screen.findByText(en.updFailed)).toBeTruthy();
    expect(screen.getByTestId('update-btn').textContent).toBe(en.updRetry);
    expect(screen.queryByText('APP')).toBeNull();
    expect(api.install).not.toHaveBeenCalled();
  });
});

describe('native side is wired', () => {
  it('plugin registered, install permission declared, Hindi strings present', () => {
    expect(readFileSync('android/app/src/main/java/in/dairydiary/app/MainActivity.java', 'utf8')).toContain('registerPlugin(ApkUpdaterPlugin.class)');
    expect(readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8')).toContain('android.permission.REQUEST_INSTALL_PACKAGES');
    const j = readFileSync('android/app/src/main/java/in/dairydiary/app/ApkUpdaterPlugin.java', 'utf8');
    expect(j).toContain('@CapacitorPlugin(name = "ApkUpdater")');
    expect(j).toContain('https://github.com/rahulyadavoxo/dairy-diary/releases/download/');
    for (const k of ['updTitle', 'updBody', 'updNow', 'updDownloading', 'updInstallHint', 'updPermHint', 'updFailed', 'updRetry', 'updCurrent'])
      expect(STRINGS.hi[k] && STRINGS.en[k]).toBeTruthy();
  });
});

describe('1.10.16: sync first, then the Update screen', () => {
  beforeEach(() => cleanup());
  it('while unsynced entries are uploading the app stays usable; the Update screen comes after', async () => {
    let done;
    const api = {
      current: vi.fn(async () => '1.10.16'),
      check: vi.fn(async () => ({ version: '1.10.17', url: 'u' })),
      download: vi.fn(),
      install: vi.fn(),
      sync: vi.fn(() => new Promise((r) => (done = r))),
    };
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => expect(api.sync).toHaveBeenCalled());
    expect(screen.getByText('APP')).toBeTruthy();
    expect(screen.queryByTestId('update-gate')).toBeNull();
    done();
    expect(await screen.findByTestId('update-gate')).toBeTruthy();
    expect(screen.queryByText('APP')).toBeNull();
  });
  it('no update -> no sync wait at all', async () => {
    const api = { current: vi.fn(async () => '1.10.16'), check: vi.fn(async () => null), sync: vi.fn(), download: vi.fn(), install: vi.fn() };
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => expect(api.check).toHaveBeenCalled());
    expect(api.sync).not.toHaveBeenCalled();
  });
  it('getFirebase shares one init between callers', () => {
    const src = readFileSync('src/firebase.js', 'utf8');
    expect(src).toContain('let initing = null;');
    expect(readFileSync('src/appUpdate.js', 'utf8')).toContain('waitForPendingWrites');
  });
});
