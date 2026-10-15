import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import UpdateGate from '../src/components/UpdateGate.jsx';
import { readFileSync } from 'node:fs';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;

describe('1.10.26 faster update start', () => {
  beforeEach(() => cleanup());
  it('shows Connecting… until the first bytes arrive, then the percent', async () => {
    let onPct;
    let finish;
    const api = {
      current: vi.fn(async () => '1.10.25'),
      check: vi.fn(async () => ({ version: '1.10.26', url: 'https://github.com/rahulyadavoxo/dairy-diary/releases/download/v1.10.26/dairy-diary-v1.10.26.apk' })),
      sync: vi.fn(async () => {}),
      download: vi.fn((url, cb) => { onPct = cb; return new Promise((r) => { finish = r; }); }),
      install: vi.fn(async () => ({ started: true })),
    };
    render(wrap(<UpdateGate api={api} native>{<p>APP</p>}</UpdateGate>));
    fireEvent.click(await screen.findByTestId('update-btn'));
    expect((await screen.findByTestId('update-pct')).textContent).toBe(en.updConnecting);
    act(() => onPct(0));
    expect(screen.getByTestId('update-pct').textContent).toBe(en.updDownloading + ' 0%');
    act(() => onPct(40));
    expect(screen.getByTestId('update-pct').textContent).toBe(en.updDownloading + ' 40%');
    await act(async () => finish({ size: 1 }));
  });
  it('native updater: short connect timeout with retries (no 20 s stall per address)', () => {
    const j = readFileSync('android/app/src/main/java/in/dairydiary/app/ApkUpdaterPlugin.java', 'utf8');
    expect(j).toContain('CONNECT_TIMEOUT_MS = 4000');
    expect(j).toContain('setConnectTimeout(CONNECT_TIMEOUT_MS)');
    expect(j).not.toContain('setConnectTimeout(20000)');
    expect(j).toMatch(/CONNECT_TRIES = \d/);
    expect(STRINGS.hi.updConnecting).toBeTruthy();
  });
});
