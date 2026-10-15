import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { LangContext, makeT } from '../src/i18n.js';
import UpdateGate from '../src/components/UpdateGate.jsx';
import { POLL_WHILE_OPEN_MS } from '../src/appUpdate.js';

const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
afterEach(() => cleanup());

describe('1.10.19 update is caught while the app is open (no restart needed)', () => {
  it('polls every few minutes while open and shows the Update screen when a release appears', async () => {
    let latest = null;
    const api = { current: vi.fn(async () => '1.10.19'), check: vi.fn(async () => latest), sync: vi.fn(async () => {}), download: vi.fn(), install: vi.fn() };
    render(wrap(<UpdateGate api={api} native pollMs={30}>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => expect(api.check).toHaveBeenCalled());
    expect(screen.getByText('APP')).toBeTruthy();
    latest = { version: '1.10.20', url: 'u' };
    await waitFor(() => expect(screen.getByTestId('update-gate')).toBeTruthy());
    expect(api.check.mock.calls.length).toBeGreaterThan(1);
  });
  it('internet coming back triggers a check at once', async () => {
    const api = { current: vi.fn(async () => '1.10.19'), check: vi.fn(async () => null), sync: vi.fn(), download: vi.fn(), install: vi.fn() };
    render(wrap(<UpdateGate api={api} native pollMs={1e9}>{<p>APP</p>}</UpdateGate>));
    await waitFor(() => expect(api.check).toHaveBeenCalledTimes(1));
    await act(async () => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(api.check).toHaveBeenCalledTimes(2));
  });
  it('default poll stays well inside GitHub limits (>= 5 min)', () => {
    expect(POLL_WHILE_OPEN_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });
});

import StickySearch from '../src/components/StickySearch.jsx';
import { readFileSync } from 'node:fs';
describe('1.10.19 search icon on the right', () => {
  it('pinned search shows a magnifier icon after the input; hidden while text is typed', () => {
    const r = render(<StickySearch><input className="search" type="search" placeholder="Search" /></StickySearch>);
    const icon = r.getByTestId('search-icon');
    expect(icon.previousElementSibling.tagName).toBe('INPUT');
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toMatch(/\.search-box \.search-icon-r \{ position: absolute; right:/);
    expect(css).toMatch(/:not\(:placeholder-shown\) ~ \.search-icon-r \{ display: none; \}/);
  });
});

import { swipeTarget, blockedTarget, TAB_ORDER } from '../src/swipeTabs.js';
describe('1.10.20 swipe between tabs', () => {
  const s = { x: 300, y: 400, t: 0 };
  it('flick left goes to the next tab, right to the previous', () => {
    expect(swipeTarget('register', s, { x: 150, y: 410, t: 200 })).toBe('hisaab');
    expect(swipeTarget('hisaab', s, { x: 450, y: 390, t: 200 })).toBe('register');
    expect(swipeTarget('hisaab', s, { x: 150, y: 400, t: 200 })).toBe('customers');
  });
  it('no wrap at the ends; short, slow or mostly-vertical moves are ignored', () => {
    expect(swipeTarget('register', s, { x: 450, y: 400, t: 200 })).toBeNull();
    expect(swipeTarget('settings', s, { x: 150, y: 400, t: 200 })).toBeNull();
    expect(swipeTarget('register', s, { x: 260, y: 400, t: 100 })).toBeNull();
    expect(swipeTarget('register', s, { x: 150, y: 400, t: 2000 })).toBeNull();
    expect(swipeTarget('register', s, { x: 200, y: 600, t: 200 })).toBeNull();
    expect(TAB_ORDER).toEqual(['register', 'hisaab', 'customers', 'settings']);
  });
  it('swipes starting in a text box or a popup do not switch tab', () => {
    document.body.innerHTML = '<div class="modal-backdrop"><p id="a">x</p></div><input id="b"/><p id="c">ok</p>';
    expect(blockedTarget(document.getElementById('a'))).toBe(true);
    expect(blockedTarget(document.getElementById('b'))).toBe(true);
    expect(blockedTarget(document.getElementById('c'))).toBe(false);
    document.body.innerHTML = '';
  });
});

import { CHECK_EVERY_MS } from '../src/appUpdate.js';
describe('1.10.21 resume check', () => {
  it('coming back to the app re-checks GitHub after just 1 minute', () => {
    expect(CHECK_EVERY_MS).toBe(60 * 1000);
  });
});
