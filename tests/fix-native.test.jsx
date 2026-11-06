// Fixes from the native / WhatsApp-bills check (Nov 2026): findings #1-#12 + money #3.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';

const state = vi.hoisted(() => ({ native: false, shareImages: [] }));
vi.mock('@capacitor/core', async (orig) => {
  const real = await orig();
  return {
    ...real,
    Capacitor: { ...real.Capacitor, isNativePlatform: () => state.native },
    registerPlugin: (name, ...rest) =>
      name === 'WhatsAppShare'
        ? { shareImages: vi.fn(async (o) => { state.shareImages.push(o); }), shareImage: vi.fn(async () => ({})), saveBill: vi.fn(async (o) => ({ name: `${o.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}-${state.shareImages.length}-${Math.random().toString(36).slice(2)}.png` })) }
        : real.registerPlugin(name, ...rest),
  };
});
vi.mock('../src/billImage.js', async (orig) => ({
  ...(await orig()),
  renderBillImage: vi.fn(async (row) => {
    await new Promise((r) => setTimeout(r, 50));
    return new Blob([`${row.customerId}:${row.balancePaise}`]);
  }),
}));
vi.mock('../src/billCache.js', () => ({ getCachedPhoto: vi.fn(async () => null), putCachedPhoto: vi.fn(), deleteCachedPhoto: vi.fn() }));
vi.mock('../src/billPreGen.js', () => ({ preGenerateBillPhotos: vi.fn() }));
const sent = [];
const blobs = [];
const names = [];
vi.mock('../src/waShare.js', async (orig) => ({
  ...(await orig()),
  sendBillToWhatsApp: vi.fn(async ({ phone, blob, fileName }) => {
    sent.push(phone);
    names.push(fileName);
    blobs.push(await blob.text());
    return 'direct';
  }),
}));

import BillSender, { CHAIN_SECONDS, freezeOrder, isBillTarget } from '../src/screens/BillSender.jsx';
import BillPhotos from '../src/screens/BillPhotos.jsx';
import { billFileName } from '../src/billImage.js';
import { shareManyImages } from '../src/waShare.js';
import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { addDays, addMonths, monthOf, todayISO } from '../src/format.js';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { vi.advanceTimersByTime(60); await new Promise((r) => setTimeout(r, 0)); });
};
const bm = addMonths(monthOf(todayISO()), -1);
const lastDay = addDays(`${monthOf(todayISO())}-01`, -1);
const filledLast = { [lastDay]: { entries: { gone: { milkL: 1 } } } }; // deleted customer: fills the day, no money
const abc = ['a', 'b', 'c'].map((id, i) => ({ id, name: id, phone: `987654321${i}` }));
const daysAbc = { [`${bm}-05`]: { entries: { a: { milkL: 1 }, b: { milkL: 1 }, c: { milkL: 1 } } }, ...filledLast };
const props = { fb: {}, customers: abc, days: daysAbc, payments: [], settings: { milkRatePaise: 6000 }, onClose: () => {} };
const title = () => screen.getByRole('heading', { level: 1 }).textContent;

beforeEach(() => {
  sent.length = 0;
  blobs.length = 0;
  names.length = 0;
  state.native = false;
  state.shareImages.length = 0;
  localStorage.clear();
  globalThis.URL.createObjectURL = () => 'blob:x';
  globalThis.URL.revokeObjectURL = () => {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('#1 Next during the countdown', () => {
  it('Next is hidden while the countdown runs; no customer is skipped', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(wrap(<BillSender {...props} />));
    await flush();
    fireEvent.click(screen.getByText(new RegExp(en.waChainStart)));
    await flush();
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByTestId('chain-countdown')).toBeTruthy();
    expect(screen.queryByText(new RegExp(en.waNext))).toBeNull();
    for (let i = 0; i < CHAIN_SECONDS + 1; i++) await act(async () => vi.advanceTimersByTime(1000));
    await flush();
    expect(sent).toEqual(['919876543210', '919876543211']);
    expect(title()).toContain('2/3');
  });
  it('Next after Stop moves exactly one customer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(wrap(<BillSender {...props} />));
    await flush();
    fireEvent.click(screen.getByText(new RegExp(en.waChainStart)));
    await flush();
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    fireEvent.click(screen.getByText(new RegExp(en.waChainStop)));
    fireEvent.click(screen.getByText(new RegExp(en.waNext)));
    for (let i = 0; i < CHAIN_SECONDS + 2; i++) await act(async () => vi.advanceTimersByTime(1000));
    await flush();
    expect(title()).toContain('2/3');
    expect(sent).toEqual(['919876543210']);
  });
});

describe('#2 photo follows the numbers', () => {
  it('a payment arriving while the screen is open remakes the photo that is shared', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rerender } = render(wrap(<BillSender {...props} />));
    await flush();
    const pays = [{ id: 'p', customerId: 'a', date: `${bm}-20`, amountPaise: 1000 }];
    rerender(wrap(<BillSender {...props} payments={pays} />));
    await flush();
    fireEvent.click(screen.getByText(new RegExp(en.waChainStart)));
    await flush();
    expect(blobs).toEqual(['a:5000']);
  });
});

describe('#3 unique bill file names', () => {
  it('Hindi names and same names get different ASCII names (customer id)', () => {
    const m = billFileName('मोहन', '2026-10', 'idMohan1');
    const r = billFileName('रमेश', '2026-10', 'idRamesh2');
    expect(m).not.toBe(r);
    expect(m).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(billFileName('Ramesh Yadav', '2026-10', 'x1')).not.toBe(billFileName('Ramesh Yadav', '2026-10', 'x2'));
    expect(billFileName('Ramesh Yadav', '2026-10', 'x1')).toBe('bill-2026-10-Ramesh_Yadav-x1.png');
  });
  it('BillSender shares with the id in the file name', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(wrap(<BillSender {...props} customers={abc.map((c) => ({ ...c, name: 'मोहन' }))} />));
    await flush();
    fireEvent.click(screen.getByText(new RegExp(en.waChainStart)));
    await flush();
    expect(names[0]).toBe(`bill-${bm}-a.png`);
  });
  it('Java makes a unique file per share and cleans old ones', () => {
    const j = readFileSync('android/app/src/main/java/in/dairydiary/app/WhatsAppSharePlugin.java', 'utf8');
    expect(j).toContain('System.currentTimeMillis() + ".png"');
    expect(j).toContain('OLD_BILL_MS');
    expect(j).toContain('public void shareImages(PluginCall call)');
  });
});

describe('#4 last day of the month not filled', () => {
  const days = { [`${bm}-05`]: { entries: { a: { milkL: 1 } } } };
  it('warns, holds the first share, and still lets the user send', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(wrap(<BillSender {...props} customers={[abc[0]]} days={days} />));
    await flush();
    expect(screen.getByTestId('wa-lastday-empty')).toBeTruthy();
    fireEvent.click(screen.getByText(new RegExp(en.waChainStart)));
    await flush();
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByTestId('wa-send-anyway'));
    await flush();
    expect(sent).toEqual(['919876543210']);
  });
  it('no warning once the last day is filled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(wrap(<BillSender {...props} />));
    await flush();
    expect(screen.queryByTestId('wa-lastday-empty')).toBeNull();
  });
});

describe('#5 frozen order', () => {
  it('freezeOrder keeps old positions and appends new ids', () => {
    expect(freezeOrder(['b', 'c'], ['a', 'b', 'c'])).toEqual(['b', 'c', 'a']);
    expect(freezeOrder(null, ['a'])).toEqual(['a']);
  });
  it('a customer added mid-session (id sorts first) does not shift the current one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem(`dd_wa_progress:${bm}`, JSON.stringify({ month: bm, past: true, idx: 1, ids: ['a', 'b', 'c'] }));
    const { rerender } = render(wrap(<BillSender {...props} />));
    await flush();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('b');
    const newC = { id: '0new', name: 'new', phone: '9876543299' };
    const days = { ...daysAbc, [`${bm}-06`]: { entries: { '0new': { milkL: 1 } } } };
    rerender(wrap(<BillSender {...props} customers={[newC, ...abc]} days={days} />));
    await flush();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('b');
    expect(title()).toContain('2/4');
    const saved = JSON.parse(localStorage.getItem(`dd_wa_progress:${bm}`));
    expect(saved.ids).toEqual(['a', 'b', 'c', '0new']);
  });
});

describe('#11 resume after the last customer', () => {
  it('saved idx === length shows "all sent", not the last customer again', async () => {
    localStorage.setItem(`dd_wa_progress:${bm}`, JSON.stringify({ month: bm, past: true, idx: 3, ids: ['a', 'b', 'c'] }));
    render(wrap(<BillSender {...props} />));
    expect(screen.getByText(en.waAllSent)).toBeTruthy();
  });
});

describe('money #3: inactive with dues / old balance only', () => {
  const prev = addMonths(bm, -1);
  const custs = [
    { id: 'in', name: 'Inactive', phone: '9876543210', active: false }, // milk this month, now band
    { id: 'old', name: 'Old', phone: '9876543211' }, // only an old balance
    { id: 'zero', name: 'Zero', phone: '9876543212', active: false }, // nothing at all
  ];
  const days = {
    [`${prev}-10`]: { entries: { old: { milkL: 2 } } },
    [`${bm}-05`]: { entries: { in: { milkL: 1 } } },
    ...filledLast,
  };
  it('isBillTarget includes them, skips a ₹0 nobody', () => {
    const row = (c, bal, act) => ({ customer: c, balancePaise: bal, hasActivity: act });
    expect(isBillTarget(row(custs[0], 6000, true))).toBe(true);
    expect(isBillTarget(row(custs[1], 12000, false))).toBe(true);
    expect(isBillTarget(row(custs[2], 0, false))).toBe(false);
  });
  it('Send bills lists them', async () => {
    render(wrap(<BillSender {...props} customers={custs} days={days} />));
    expect(title()).toContain('1/2');
  });
  it('Bill photos counts them', () => {
    render(wrap(<BillPhotos customers={custs} days={days} payments={[]} settings={{ milkRatePaise: 6000 }} month={bm} onClose={() => {}} />));
    expect(screen.getByText(`${en.makeBillPhotos} (2)`)).toBeTruthy();
  });
});

describe('#10 Download all on the phone', () => {
  it('native: every photo goes through ONE shareImages call with unique names', async () => {
    state.native = true;
    await shareManyImages([
      { blob: new Blob(['x']), fileName: billFileName('मोहन', bm, 'm1') },
      { blob: new Blob(['y']), fileName: billFileName('रमेश', bm, 'r2') },
    ]);
    expect(state.shareImages).toHaveLength(1);
    const names = state.shareImages[0].names;
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(state.shareImages[0].files).toBeUndefined();
  });
});

describe('#6-#9, #12 native ring source', () => {
  const rp = readFileSync('android/app/src/main/java/in/dairydiary/app/RingPlugin.java', 'utf8');
  const rx = readFileSync('android/app/src/main/java/in/dairydiary/app/RingReceiver.java', 'utf8');
  it('#6 missed-while-off ring fires after boot, never twice (done mark)', () => {
    expect(rp).toContain('static void setAll(Context ctx, boolean afterBoot)');
    expect(rx).toContain('RingPlugin.setAll(ctx, Intent.ACTION_BOOT_COMPLETED.equals(a))');
    expect(rx).toContain('putLong("done_" + id');
    expect(rp).toContain('getLong("done_" + id');
  });
  it('#7 one retry under a single deadline', () => {
    expect(rx).toContain('static int checkServer(');
    expect(rx).toContain('f.get(Math.min(left, 9000L), TimeUnit.MILLISECONDS)');
  });
  it('#8 no access stops ringing', () => {
    expect(rx).toContain('NO_ACCESS');
    // v1.10.73: a 403 is FORBIDDEN; the plan is cleared only after two 403s in a row
    expect(rx).toContain('if (code == 403) return FORBIDDEN;');
    expect(rx).toContain('if (n >= 2) server = NO_ACCESS;');
    expect(rx).toContain('INVALID_REFRESH_TOKEN');
  });
  it('#9 exact restore alarm, sync restores the volume', () => {
    expect(rx).toMatch(/setExactAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP, at, pi\)/);
    expect(rp).toContain('RingReceiver.restoreVolume(ctx);');
  });
  it('#12 cancelAll restores the volume before clearing prefs', () => {
    const body = rp.slice(rp.indexOf('public void cancelAll'));
    expect(body.indexOf('RingReceiver.restoreVolume(ctx)')).toBeLessThan(body.indexOf('.clear()'));
    expect(body).toContain('RingReceiver.cancelRestore(ctx)');
  });
});
