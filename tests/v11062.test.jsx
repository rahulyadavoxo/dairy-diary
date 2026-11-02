import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { AutoBillCard, ShareAppCard } from '../src/screens/Settings.jsx';
import { autoBillTarget, dueBillMonth, istParts, templateParams, templateMessage, balanceText } from '../src/autoBill.js';
import { computeMonth } from '../src/billing.js';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
afterEach(() => cleanup());
const at = (iso) => new Date(iso); // UTC; IST = +5:30

describe('auto-bill timing', () => {
  it('istParts converts UTC to India time', () => {
    expect(istParts(at('2026-11-30T19:00:00Z'))).toEqual({ month: '2026-12', day: 1, hm: '00:30' });
  });
  it('sends last month once the day and time have come, never twice', () => {
    const ab = { enabled: true, day: 2, time: '09:00' };
    expect(dueBillMonth(ab, at('2026-12-01T10:00:00Z'))).toBe(null); // 1 Dec
    expect(dueBillMonth(ab, at('2026-12-02T03:00:00Z'))).toBe(null); // 2 Dec 08:30 IST
    expect(dueBillMonth(ab, at('2026-12-02T03:30:00Z'))).toBe('2026-11'); // 2 Dec 09:00 IST
    expect(dueBillMonth(ab, at('2026-12-20T03:30:00Z'))).toBe('2026-11');
    expect(dueBillMonth(ab, at('2026-12-20T03:30:00Z'), '2026-11')).toBe(null);
    expect(dueBillMonth({ ...ab, enabled: false }, at('2026-12-20T03:30:00Z'))).toBe(null);
    expect(dueBillMonth(ab, at('2027-01-02T04:00:00Z'), '2026-11')).toBe('2026-12');
  });
});

describe('auto-bill message', () => {
  const customers = [
    { id: 'a', name: 'Ramesh', phone: '98765 43210' },
    { id: 'b', name: 'NoPhone' },
    { id: 's', name: 'Supplier', phone: '9876500000', isSupplier: true },
    { id: 'o', name: 'OptOut', phone: '9876511111', waAutoBill: false },
  ];
  const days = { '2026-11-03': { entries: { a: { milkL: 2, milkRatePaise: 6000 }, b: { milkL: 1, milkRatePaise: 6000 }, o: { milkL: 1, milkRatePaise: 6000 } } } };
  const { rows } = computeMonth({ customers, days, payments: [{ customerId: 'a', date: '2026-11-10', amountPaise: 2000 }], settings: {}, month: '2026-11' });
  it('targets only customers with a phone, not suppliers, not opted out', () => {
    expect(rows.filter(autoBillTarget).map((r) => r.customerId)).toEqual(['a']);
  });
  it('template parameters and Graph body', () => {
    const a = rows.find((r) => r.customerId === 'a');
    const p = templateParams(a, '2026-11', { farmName: 'Yadav Dairy' });
    expect(p[0]).toBe('Ramesh');
    expect(p[1]).toMatch(/नवंबर/);
    expect(p[2]).toBe('₹120');
    expect(p[3]).toBe('₹100 बाकी');
    expect(p[4]).toBe('Yadav Dairy');
    const m = templateMessage('98765 43210', p, { name: 'dd_bill', lang: 'hi' });
    expect(m.to).toBe('919876543210');
    expect(m.template.components[0].parameters).toHaveLength(5);
    expect(balanceText(-5000)).toBe('₹50 एडवांस');
  });
});

describe('WhatsApp connect UI', () => {
  const fb = { farmId: 'f', fsMod: { doc: (_d, ...p) => ({ path: p.join('/') }), setDoc: vi.fn(async () => {}) } };
  const api = (o = {}) => ({ connect: vi.fn(async () => ({ display: 'Yadav Dairy +91 98765' })), disconnect: vi.fn(async () => {}), test: vi.fn(async () => ({})), ...o });
  it('owner connects with Phone number ID + token', async () => {
    const a = api();
    render(wrap(<AutoBillCard fb={fb} settings={{}} isOwner waApi={a} />));
    fireEvent.click(screen.getByTestId('wa-connect'));
    fireEvent.change(screen.getByTestId('wa-pnid'), { target: { value: '123456789' } });
    fireEvent.change(screen.getByTestId('wa-token'), { target: { value: 'EAAG-secret-token-xxxxxxxx' } });
    fireEvent.click(screen.getByTestId('wa-connect-submit'));
    await waitFor(() => expect(a.connect).toHaveBeenCalledWith(fb, { phoneNumberId: '123456789', accessToken: 'EAAG-secret-token-xxxxxxxx', templateName: 'dd_bill', templateLang: 'hi' }));
    expect(await screen.findByText(/Yadav Dairy \+91 98765/)).toBeTruthy();
  });
  it('a joined phone cannot connect or test; owner sees last run and can test', async () => {
    const { unmount } = render(wrap(<AutoBillCard fb={fb} settings={{ autoBill: { connected: true } }} isOwner={false} waApi={api()} />));
    expect(screen.queryByTestId('wa-test')).toBeNull();
    unmount();
    const r2 = render(wrap(<AutoBillCard fb={fb} settings={{}} isOwner={false} waApi={api()} />));
    expect(screen.queryByTestId('wa-connect')).toBeNull();
    expect(screen.getByText(en.waOwnerOnly)).toBeTruthy();
    r2.unmount();
    const a = api();
    const settings = { autoBill: { connected: true, display: 'D', lastRun: { month: '2026-10', sent: 40, failed: 2 } } };
    render(wrap(<AutoBillCard fb={fb} settings={settings} isOwner waApi={a} />));
    expect(screen.getByTestId('autobill-lastrun').textContent).toContain('✓ 40');
    fireEvent.change(screen.getByTestId('wa-test-phone'), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByTestId('wa-test'));
    await waitFor(() => expect(a.test).toHaveBeenCalledWith(fb, '9876543210', settings));
  });
  it('a Meta error is shown', async () => {
    const a = api({ connect: vi.fn(async () => { throw new Error('WhatsApp: 190: Invalid OAuth access token'); }) });
    render(wrap(<AutoBillCard fb={fb} settings={{}} isOwner waApi={a} />));
    fireEvent.click(screen.getByTestId('wa-connect'));
    fireEvent.change(screen.getByTestId('wa-pnid'), { target: { value: '123456789' } });
    fireEvent.change(screen.getByTestId('wa-token'), { target: { value: 'EAAG-secret-token-xxxxxxxx' } });
    fireEvent.click(screen.getByTestId('wa-connect-submit'));
    expect(await screen.findByText(/Invalid OAuth/)).toBeTruthy();
  });
  it('share app opens WhatsApp with the download Page link', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(wrap(<ShareAppCard />));
    fireEvent.click(screen.getByTestId('share-app'));
    expect(decodeURIComponent(open.mock.calls[0][0])).toContain('rahulyadavoxo.github.io/dairy-diary/download.html');
    open.mockRestore();
  });
  it('rules: waPrivate only for the owner account; cron logs no ids', () => {
    const rules = readFileSync('firestore.rules', 'utf8');
    expect(rules).toMatch(/match \/waPrivate\/\{docId\}[\s\S]*request\.auth\.uid == farmId/);
    expect(readFileSync('functions/cron.mjs', 'utf8')).toContain('log: () => {}');
    expect(readFileSync('.github/workflows/autobill.yml', 'utf8')).toContain("cron: '*/15 * * * *'");
  });
});

// ---- server runner with a fake Firestore + fake Meta ----
function fakeDb(docs) {
  const store = new Map(Object.entries(docs));
  const snap = (path) => ({ id: path.split('/').pop(), exists: store.has(path), data: () => (store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : undefined) });
  const merge = (a, b) => {
    const o = { ...(a || {}) };
    for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' ? merge(o[k], v) : v;
    return o;
  };
  return {
    store,
    doc: (path) => ({ get: async () => snap(path), set: async (v, opt) => store.set(path, opt && opt.merge ? merge(store.get(path), v) : v) }),
    collection: (path) => ({ get: async () => ({ docs: [...store.keys()].filter((k) => k.startsWith(path + '/') && k.split('/').length === path.split('/').length + 1).map(snap) }) }),
    collectionGroup: (name) => ({
      get: async () => ({ docs: [...store.keys()].filter((k) => k.split('/').slice(-2)[0] === name).map((k) => ({ ...snap(k), ref: { parent: { parent: { id: k.split('/')[1] } } } })) }),
    }),
  };
}

describe('auto-bill runner (GitHub cron)', () => {
  beforeAll(() => execSync('bash scripts/sync-functions-shared.sh'));
  const base = () => ({
    'farms/F/settings/main': { farmName: 'Yadav Dairy', autoBill: { enabled: true, day: 1, time: '09:00' } },
    'farms/F/waPrivate/main': { phoneNumberId: '111222333', accessToken: 'tok-xxxxxxxxxxxxxxxxxxxx', template: { name: 'dd_bill', lang: 'hi' } },
    'farms/F/customers/a': { name: 'Ramesh', phone: '9876543210' },
    'farms/F/customers/b': { name: 'Suresh', phone: '9876500001' },
    'farms/F/days/2026-11-03': { entries: { a: { milkL: 2, milkRatePaise: 6000 }, b: { milkL: 1, milkRatePaise: 6000 } } },
  });
  const now = new Date('2026-12-01T04:00:00Z'); // 1 Dec 09:30 IST
  it('sends each customer once, marks the month done, never resends', async () => {
    const { runAll } = await import('../functions/runner.js');
    const db = fakeDb(base());
    const calls = [];
    globalThis.fetch = vi.fn(async (url, o) => {
      calls.push(JSON.parse(o.body));
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.' + calls.length }] }) };
    });
    const r = await runAll(db, { now, log: () => {} });
    expect(r).toEqual({ checked: 1, sentRuns: 1 });
    expect(calls.map((c) => c.to)).toEqual(['919876543210', '919876500001']);
    expect(calls[0].template.components[0].parameters.map((p) => p.text)).toEqual(['Ramesh', expect.stringMatching(/नवंबर/), '₹120', '₹120 बाकी', 'Yadav Dairy']);
    const s = db.store.get('farms/F/settings/main').autoBill;
    expect(s.doneMonth).toBe('2026-11');
    expect(s.lastRun).toMatchObject({ month: '2026-11', sent: 2, failed: 0, done: true });
    await runAll(db, { now, log: () => {} });
    expect(calls).toHaveLength(2);
  });
  it('a bad token stops the run and the next run resumes', async () => {
    const { runAll } = await import('../functions/runner.js');
    const db = fakeDb(base());
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 190, message: 'Invalid OAuth access token' } }) }));
    await runAll(db, { now, log: () => {} });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const s = db.store.get('farms/F/settings/main').autoBill;
    expect(s.doneMonth).toBeUndefined();
    expect(s.lastRun.error).toMatch(/^190/);
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ messages: [{ id: 'm' }] }) }));
    await runAll(db, { now, log: () => {} });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(db.store.get('farms/F/settings/main').autoBill.doneMonth).toBe('2026-11');
  });
  it('nothing is sent before the day/time', async () => {
    const { runAll } = await import('../functions/runner.js');
    const db = fakeDb(base());
    globalThis.fetch = vi.fn();
    await runAll(db, { now: new Date('2026-12-01T03:00:00Z'), log: () => {} });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
