// 1.10.73 fix-bills: bills + WhatsApp + auto-bill review (10 issues).
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

let renders = 0;
vi.mock('../src/billImage.js', async (orig) => ({
  ...(await orig()),
  renderBillImage: vi.fn(async (row) => {
    renders++;
    return new Blob([`${row.customerId}:${row.leftPaise ?? row.balancePaise}`]);
  }),
}));
vi.mock('../src/billCache.js', () => ({ getCachedPhoto: vi.fn(async () => null), putCachedPhoto: vi.fn(async () => {}), deleteCachedPhoto: vi.fn() }));
const sent = [];
const shared = [];
vi.mock('../src/waShare.js', async (orig) => ({
  ...(await orig()),
  sendBillToWhatsApp: vi.fn(async ({ phone, blob }) => {
    sent.push({ phone, text: await blob.text() });
    return 'direct';
  }),
  shareManyImages: vi.fn(async (list) => {
    for (const x of list) shared.push(await x.blob.text());
  }),
}));
vi.mock('../src/db.js', async (orig) => ({ ...(await orig()), saveSettings: vi.fn(() => Promise.resolve()), markHandSent: vi.fn(() => Promise.resolve()) }));

import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { okWaNumber, autoBillTarget, lastDayWait, templateParams } from '../src/autoBill.js';
import { validWaNumber } from '../src/waShare.js';
import { computeMonth, withLaterPayments, billBalance, leftOf } from '../src/billing.js';
import { billText } from '../src/bill.js';
import { shouldPromptBills, recordsHandSend } from '../src/screens/BillSender.jsx';
import BillSender from '../src/screens/BillSender.jsx';
import BillPhotos from '../src/screens/BillPhotos.jsx';
import { AutoBillCard } from '../src/screens/Settings.jsx';
import * as db from '../src/db.js';
import { addDays, addMonths, monthOf, todayISO } from '../src/format.js';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---- fake Firestore (merge like Firestore: nested maps merge, FieldValue.delete removes) ----
const DEL = { __delete: true };
function fakeDb(docs) {
  const store = new Map(Object.entries(docs));
  const snap = (path) => ({ id: path.split('/').pop(), exists: store.has(path), data: () => (store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : undefined) });
  const merge = (a, b) => {
    const o = { ...(a || {}) };
    for (const [k, v] of Object.entries(b)) {
      if (v === DEL) delete o[k];
      else o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' ? merge(o[k], v) : v;
    }
    return o;
  };
  const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x === DEL ? undefined : x)));
  return {
    store,
    doc: (path) => ({ get: async () => snap(path), set: async (v, opt) => store.set(path, opt && opt.merge ? merge(store.get(path), v) : strip(v)) }),
    collection: (path) => ({ get: async () => ({ docs: [...store.keys()].filter((k) => k.startsWith(path + '/') && k.split('/').length === path.split('/').length + 1).map(snap) }) }),
    collectionGroup: (name) => ({
      get: async () => ({ docs: [...store.keys()].filter((k) => k.split('/').slice(-2)[0] === name).map((k) => ({ ...snap(k), ref: { parent: { parent: { id: k.split('/')[1] } } } })) }),
    }),
  };
}
const ok = (id) => ({ ok: true, json: async () => ({ messages: [{ id }] }) });
const err = (code, status = 400) => ({ ok: false, status, json: async () => ({ error: { code, message: 'x' } }) });
const toOf = (o) => JSON.parse(o.body).to;

describe('auto-bill runner', () => {
  beforeAll(() => execSync('bash scripts/sync-functions-shared.sh'));
  const now = new Date('2026-12-01T04:00:00Z'); // 1 Dec 09:30 IST
  const base = (extra = {}) => ({
    'farms/F/settings/main': { farmName: 'Yadav Dairy', autoBill: { enabled: true, day: 1, time: '09:00', connected: true } },
    'farms/F/waPrivate/main': { phoneNumberId: '111', accessToken: 'tok-xxxxxxxxxxxxxxxxxxxx' },
    'farms/F/customers/a': { name: 'Ramesh', phone: '9876543210' },
    'farms/F/customers/b': { name: 'Suresh', phone: '9876500001' },
    'farms/F/customers/c': { name: 'Mohan', phone: '9876500002' },
    'farms/F/days/2026-11-03': { entries: { a: { milkL: 2, milkRatePaise: 6000 }, b: { milkL: 1, milkRatePaise: 6000 }, c: { milkL: 1, milkRatePaise: 6000 } } },
    'farms/F/days/2026-11-30': { entries: { a: { milkL: 1, milkRatePaise: 6000 } } },
    ...extra,
  });
  const run = async (db, opts = {}) => {
    const { runAll } = await import('../functions/runner.js');
    return runAll(db, { now, log: () => {}, fieldDelete: () => DEL, ...opts });
  };

  it('#1 error 100 fails only that customer; the rest of the dairy still gets bills', async () => {
    const db = fakeDb(base());
    globalThis.fetch = vi.fn(async (u, o) => (toOf(o) === '919876543210' ? err(100) : ok('m')));
    await run(db);
    expect(globalThis.fetch.mock.calls.map((c) => toOf(c[1]))).toEqual(['919876543210', '919876500001', '919876500002']);
    const r = db.store.get('farms/F/waRuns/2026-11');
    expect(Object.keys(r.sent).sort()).toEqual(['b', 'c']);
    expect(r.tries.a).toBe(1);
    const { FATAL } = await import('../functions/runner.js');
    expect(FATAL.test('100: Invalid parameter')).toBe(false);
    expect(FATAL.test('190: token')).toBe(true);
  });

  it('#1 phone check = the app\'s validWaNumber (invalid numbers never go to Meta)', () => {
    for (const p of ['12345 67890', '0091 98765 43210', '98765 43210', '+44 7700 900123', '5555']) {
      expect(okWaNumber(p.replace(/\D/g, '').length === 10 ? '91' + p.replace(/\D/g, '') : p.replace(/\D/g, ''))).toBe(!!validWaNumber(p));
    }
    const row = (phone) => ({ customer: { name: 'x', phone }, balancePaise: 100, hasActivity: true });
    expect(autoBillTarget(row('12345 67890'))).toBe(false);
    expect(autoBillTarget(row('0091 98765 43210'))).toBe(false);
    expect(autoBillTarget(row('98765 43210'))).toBe(true);
  });

  it('#3 customers sent by hand (run log `manual`) are skipped and count as sent', async () => {
    const db = fakeDb(base({ 'farms/F/waRuns/2026-11': { manual: { a: 1, b: 2 } } }));
    globalThis.fetch = vi.fn(async () => ok('m'));
    await run(db);
    expect(globalThis.fetch.mock.calls.map((c) => toOf(c[1]))).toEqual(['919876500002']);
    const s = db.store.get('farms/F/settings/main');
    expect(s.autoBill.lastRun).toMatchObject({ done: true, failed: 0, manual: 2 });
    expect(s.billsSentForMonth).toBe('2026-12');
  });

  it('#4 waits for the last day of the month (until the 3rd), then sends', async () => {
    const docs = base();
    delete docs['farms/F/days/2026-11-30'];
    const db = fakeDb(docs);
    globalThis.fetch = vi.fn(async () => ok('m'));
    await run(db);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(db.store.get('farms/F/settings/main').autoBill.lastRun).toMatchObject({ month: '2026-11', waiting: 'lastDayEmpty', done: false });
    await run(db, { now: new Date('2026-12-02T12:00:00Z') });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await run(db, { now: new Date('2026-12-03T04:00:00Z') }); // 3 Dec: send anyway
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    // filled -> no wait
    const days = { '2026-11-30': { entries: { a: { milkL: 1 } } } };
    expect(lastDayWait(days, [{ id: 'a' }], '2026-11', now)).toBe(false);
    expect(lastDayWait({}, [{ id: 'a' }], '2026-11', now)).toBe(true);
    expect(lastDayWait({}, [{ id: 's', isSupplier: true }], '2026-11', now)).toBe(false);
  });

  it('#5 a failure that succeeds on retry is removed (doc + Settings count)', async () => {
    const db = fakeDb(base());
    globalThis.fetch = vi.fn(async (u, o) => (toOf(o) === '919876500001' ? err(131026) : ok('m')));
    await run(db);
    expect(db.store.get('farms/F/settings/main').autoBill.lastRun).toMatchObject({ failed: 1, done: false });
    globalThis.fetch = vi.fn(async () => ok('m2'));
    await run(db);
    expect(db.store.get('farms/F/waRuns/2026-11').failed).toEqual({});
    expect(db.store.get('farms/F/settings/main').autoBill.lastRun).toMatchObject({ failed: 0, sent: 3, done: true });
  });

  it('#6 everybody failed -> month NOT done, hand banner not switched off', async () => {
    const db = fakeDb(base());
    globalThis.fetch = vi.fn(async () => err(131026));
    for (let i = 0; i < 4; i++) await run(db);
    const s = db.store.get('farms/F/settings/main');
    expect(s.autoBill.doneMonth).toBeUndefined();
    expect(s.billsSentForMonth).toBeUndefined();
    expect(s.autoBill.lastRun).toMatchObject({ done: false, sent: 0, failed: 3 });
    expect(s.autoBill.lastRun.error).toMatch(/131026/);
    expect(db.store.get('farms/F/waRuns/2026-11').status).toBe('failed');
    expect(globalThis.fetch).toHaveBeenCalledTimes(9); // 3 tries each, then it stops
  });

  it('#6 partial failure: month done, but billsSentForMonth stays (hand banner for the rest)', async () => {
    const db = fakeDb(base());
    globalThis.fetch = vi.fn(async (u, o) => (toOf(o) === '919876500001' ? err(131026) : ok('m')));
    for (let i = 0; i < 3; i++) await run(db);
    const s = db.store.get('farms/F/settings/main');
    expect(s.autoBill.doneMonth).toBe('2026-11');
    expect(s.billsSentForMonth).toBeUndefined();
  });

  it('#6 Meta outage (5xx / network) burns no tries; the run resumes later', async () => {
    const db = fakeDb(base());
    globalThis.fetch = vi.fn(async () => err(2, 503));
    for (let i = 0; i < 4; i++) await run(db);
    expect(globalThis.fetch).toHaveBeenCalledTimes(4); // one call per run, then it waits
    expect(db.store.get('farms/F/waRuns/2026-11').tries).toEqual({});
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed'); });
    await run(db);
    expect(db.store.get('farms/F/settings/main').autoBill.doneMonth).toBeUndefined();
    globalThis.fetch = vi.fn(async () => ok('m'));
    await run(db);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(db.store.get('farms/F/settings/main')).toMatchObject({ billsSentForMonth: '2026-12', autoBill: { doneMonth: '2026-11' } });
  });

  it('#7 every Graph call has a timeout signal', async () => {
    const { graph } = await import('../functions/runner.js');
    globalThis.fetch = vi.fn(async () => ok('m'));
    await graph('1/messages', 'tok', { a: 1 });
    expect(globalThis.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('cron passes FieldValue.delete; template still has 5 params', () => {
    expect(readFileSync('functions/cron.mjs', 'utf8')).toContain('FieldValue.delete()');
    const row = { customer: { name: 'A' }, billedPaise: 100, balancePaise: 100 };
    expect(templateParams(row, '2026-11', {})).toHaveLength(5);
  });

  it('rules: a farm device may write only waRuns.manual', () => {
    const rules = readFileSync('firestore.rules', 'utf8');
    expect(rules).toMatch(/match \/waRuns\/\{month\}[\s\S]*affectedKeys\(\)\.hasOnly\(\['manual'\]\)/);
  });
});

describe('#2 1st-of-month banner while auto-bill is on', () => {
  const today = '2026-12-01';
  it('hidden while auto-bill is on and connected; back when the run failed', () => {
    expect(shouldPromptBills({}, today)).toBe(true);
    expect(shouldPromptBills({ billsSentForMonth: '2026-12' }, today)).toBe(false);
    expect(shouldPromptBills({ autoBill: { enabled: true } }, today)).toBe(true); // not connected: hand only
    expect(shouldPromptBills({ autoBill: { enabled: true, connected: true } }, today)).toBe(false);
    expect(shouldPromptBills({ autoBill: { enabled: true, connected: true, lastRun: { month: '2026-11', done: false, error: '' } } }, today)).toBe(false);
    expect(shouldPromptBills({ autoBill: { enabled: true, connected: true, lastRun: { month: '2026-11', done: false, error: '190: token' } } }, today)).toBe(true);
    expect(shouldPromptBills({ autoBill: { enabled: true, connected: true } }, '2026-12-02')).toBe(false);
  });
});

describe('#3 hand sends recorded for the server', () => {
  beforeEach(() => {
    sent.length = 0;
    localStorage.clear();
    globalThis.URL.createObjectURL = () => 'blob:x';
    globalThis.URL.revokeObjectURL = () => {};
    db.markHandSent.mockClear();
  });
  const bm = addMonths(monthOf(todayISO()), -1);
  const customers = [{ id: 'a', name: 'Asha', phone: '9876543210', order: 10 }];
  const days = {
    [`${bm}-05`]: { entries: { a: { milkL: 1 } } },
    [addDays(`${monthOf(todayISO())}-01`, -1)]: { entries: { a: { milkL: 1 } } },
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  it('recordsHandSend only for a finished month with auto-bill on', () => {
    expect(recordsHandSend({ autoBill: { enabled: true } }, true)).toBe(true);
    expect(recordsHandSend({ autoBill: { enabled: true } }, false)).toBe(false);
    expect(recordsHandSend({}, true)).toBe(false);
  });
  it('sending last month by hand with auto-bill on writes waRuns/{month}.manual', async () => {
    const fb = { farmId: 'F' };
    render(wrap(<BillSender fb={fb} customers={customers} days={days} payments={[]} settings={{ milkRatePaise: 6000, autoBill: { enabled: true, connected: true } }} month={bm} onClose={() => {}} />));
    await flush();
    fireEvent.click(screen.getByText(new RegExp(en.waChainStart)));
    await flush();
    expect(sent).toHaveLength(1);
    expect(db.markHandSent).toHaveBeenCalledWith(fb, bm, 'a');
  });
  it('auto-bill off: nothing recorded', async () => {
    render(wrap(<BillSender fb={{ farmId: 'F' }} customers={customers} days={days} payments={[]} settings={{ milkRatePaise: 6000 }} month={bm} onClose={() => {}} />));
    await flush();
    fireEvent.click(screen.getByText(new RegExp(en.waChainStart)));
    await flush();
    expect(sent).toHaveLength(1);
    expect(db.markHandSent).not.toHaveBeenCalled();
  });
  it('markHandSent writes only the manual map of farms/{id}/waRuns/{month}', async () => {
    const real = await vi.importActual('../src/db.js');
    const setDoc = vi.fn(() => Promise.resolve());
    real.markHandSent({ farmId: 'F', db: {}, fsMod: { doc: (_d, ...p) => p.join('/'), setDoc } }, '2026-11', 'a');
    expect(setDoc.mock.calls[0][0]).toBe('farms/F/waRuns/2026-11');
    expect(Object.keys(setDoc.mock.calls[0][1])).toEqual(['manual']);
    expect(setDoc.mock.calls[0][2]).toEqual({ merge: true });
  });
});

describe('#8 moving the send day earlier while auto-bill is on', () => {
  const fb = { farmId: 'f' };
  const api = { connect: vi.fn(), disconnect: vi.fn(), test: vi.fn() };
  beforeEach(() => db.saveSettings.mockClear());
  const save = (settings, day) => {
    render(wrap(<AutoBillCard fb={fb} settings={settings} isOwner waApi={api} />));
    fireEvent.change(screen.getByTestId('autobill-day'), { target: { value: String(day) } });
    fireEvent.click(screen.getByTestId('autobill-save'));
    return db.saveSettings.mock.calls[0][1].autoBill;
  };
  it('day 10 -> 3 on 6 Nov: October is NOT sent late', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
    expect(save({ autoBill: { enabled: true, day: 10, time: '09:00', connected: true } }, 3)).toMatchObject({ day: 3, doneMonth: '2026-10' });
  });
  it('the old day had already come (run due anyway): nothing skipped', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
    expect(save({ autoBill: { enabled: true, day: 4, time: '09:00', connected: true } }, 2).doneMonth).toBeUndefined();
  });
  it('moving it later than today: nothing skipped', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
    expect(save({ autoBill: { enabled: true, day: 10, time: '09:00', connected: true } }, 12).doneMonth).toBeUndefined();
  });
});

describe('#9 paid later more than the due shows the advance', () => {
  const customers = [{ id: 'a', name: 'Ram', phone: '9876543210' }];
  const days = { '2026-10-05': { entries: { a: { milkL: 5, milkRatePaise: 10000 } } } }; // ₹500
  const payments = [{ customerId: 'a', date: '2026-11-03', amountPaise: 80000 }];
  const row = withLaterPayments(computeMonth({ customers, days, payments, settings: {}, month: '2026-10' }).rows[0], payments, '2026-10', '2026-11-06');
  it('bill balance = -₹300 (advance); Hisaab left stays ₹0', () => {
    expect(row.balancePaise).toBe(50000);
    expect(leftOf(row)).toBe(0);
    expect(billBalance(row)).toBe(-30000);
    const txt = billText(row, '2026-10', {});
    expect(txt).toMatch(/Paid later: ₹800/);
    expect(txt).toMatch(/Advance: ₹300/);
    expect(templateParams(row, '2026-10', {})[3]).toBe('₹300 एडवांस');
  });
  it('partly paid later: unchanged', () => {
    const p2 = [{ customerId: 'a', date: '2026-11-03', amountPaise: 20000 }];
    const r2 = withLaterPayments(computeMonth({ customers, days, payments: p2, settings: {}, month: '2026-10' }).rows[0], p2, '2026-10', '2026-11-06');
    expect(billBalance(r2)).toBe(30000);
  });
});

describe('#10 BillPhotos remakes a photo when its numbers change', () => {
  beforeEach(() => {
    sent.length = 0;
    shared.length = 0;
    renders = 0;
    globalThis.URL.createObjectURL = () => 'blob:x';
    globalThis.URL.revokeObjectURL = () => {};
  });
  const customers = [{ id: 'm', name: 'Mohan', phone: '9876543210' }];
  const days = { '2026-10-05': { entries: { m: { milkL: 10, milkRatePaise: 10000 } } } }; // ₹1,000
  const props = { customers, days, settings: {}, month: '2026-10', onClose: () => {} };
  it('a payment after "Make bill photos" -> share sends the new amount', async () => {
    const r = render(wrap(<BillPhotos {...props} payments={[]} />));
    fireEvent.click(screen.getByText(new RegExp(en.makeBillPhotos)));
    await waitFor(() => expect(screen.getByText(new RegExp(en.sharePhoto))).toBeTruthy());
    expect(renders).toBe(1);
    r.rerender(wrap(<BillPhotos {...props} payments={[{ customerId: 'm', date: '2026-10-20', amountPaise: 100000 }]} />));
    await waitFor(() => expect(renders).toBe(2));
    fireEvent.click(screen.getByText(new RegExp(en.sharePhoto)));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].text).toBe('m:0');
    fireEvent.click(screen.getByText(new RegExp(en.downloadAll)));
    await waitFor(() => expect(shared).toEqual(['m:0']));
    expect(renders).toBe(2); // fresh photos are not remade again
  });
});
