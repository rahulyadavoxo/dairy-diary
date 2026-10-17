// 1.10.5: delivery Total box, sounds, suppliers on the round, "Everyone's usual" undo keeps
// corrections, scroll position kept, last-edited customer highlight, save sound / vibration.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const fx = vi.hoisted(() => ({ sounds: [], fails: 0 }));
vi.mock('../src/feedback.js', () => ({
  playSound: (n) => fx.sounds.push(n),
  vibrateFail: () => {
    fx.fails += 1;
  },
  saveFeedback: (ok) => {
    if (ok) fx.sounds.push('save');
    else fx.fails += 1;
    return ok;
  },
}));

import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { todayISO } from '../src/format.js';
import Delivery, { dayComplete, TAP_GUARD_MS } from '../src/screens/Delivery.jsx';
import Customers, { resetCustomersView } from '../src/screens/Customers.jsx';
import { useScrollKeep } from '../src/scrollKeep.js';
import { handleBack } from '../src/backStack.js';
import { act } from '@testing-library/react';
import RegisterView from '../src/screens/RegisterView.jsx';

const en = STRINGS.en;
const settings = { milkRatePaise: 6000, paneerRatePaise: 40000 };
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
function mkFb() {
  const writes = [];
  const ref = (...parts) => ({ path: parts.filter((p) => typeof p === 'string').join('/'), id: parts[parts.length - 1] });
  return {
    writes,
    farmId: 'f',
    db: {},
    fsMod: {
      doc: (...a) => (a.length === 1 ? { path: a[0].path + '/new', id: 'new' } : ref(...a.slice(1))),
      collection: (...a) => ref(...a.slice(1)),
      setDoc: vi.fn(async (r, data) => writes.push({ path: r.path, data })),
      updateDoc: vi.fn(async (r, data) => writes.push({ path: r.path, data, update: true })),
      deleteField: () => 'DEL',
      writeBatch: () => ({ update: () => {}, set: () => {}, commit: async () => {} }),
    },
  };
}
const dayWrites = (fb) => fb.writes.filter((w) => w.path.startsWith('farms/f/days/'));
const lastEntry = (fb, id) => dayWrites(fb).at(-1).data.entries[id];

const c1 = { id: 'c1', name: 'Asha', order: 10, usualMorningL: 1, usualEveningL: 1 };
const c2 = { id: 'c2', name: 'Bablu', order: 20, usualMorningL: 1, usualEveningL: 0 };
const sup = { id: 's1', name: 'Supplier Sharma', order: 15, usualMorningL: 20, usualEveningL: 0, isSupplier: true };
const props = (fb, extra = {}) => ({ fb, customers: [c1, sup, c2], days: {}, settings, displayName: 'x', onBack: () => {}, ...extra });
const box = (id) => screen.getByTestId(id);
const plus = (id) => fireEvent.click(box(id).querySelectorAll('button')[1]);
const minus = (id) => fireEvent.click(box(id).querySelectorAll('button')[0]);
const val = (id) => box(id).querySelector('input').value;

let now = 1_000_000;
beforeEach(() => {
  cleanup();
  localStorage.clear();
  fx.sounds = [];
  fx.fails = 0;
  resetCustomersView();
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());
const tap = (el) => {
  now += TAP_GUARD_MS + 1;
  fireEvent.click(el);
};

describe('delivery card: Total box', () => {
  it('editing Total zeroes morning and evening and saves a total-only entry', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb)} />));
    expect(val('qty-total')).toBe('0');
    plus('qty-total');
    plus('qty-total');
    expect([val('qty-morning'), val('qty-evening'), val('qty-total')]).toEqual(['0', '0', '0.5']);
    tap(screen.getByText(en.delivered));
    const e = lastEntry(fb, 'c1');
    expect([e.milkMorningL ?? 0, e.milkEveningL ?? 0, e.milkL]).toEqual([0, 0, 0.5]); // unchanged empty fields aren't re-sent
  });
  it('typing a Total works the same way', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb)} />));
    fireEvent.change(box('qty-total').querySelector('input'), { target: { value: '3' } });
    tap(screen.getByText(en.delivered));
    const e = lastEntry(fb, 'c1');
    expect([e.milkMorningL ?? 0, e.milkEveningL ?? 0, e.milkL]).toEqual([0, 0, 3]);
  });
  it('editing morning or evening after Total sets Total back to 0 and saves morning + evening', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb)} />));
    plus('qty-total');
    plus('qty-morning'); // 0 -> 0.25, total 0
    expect(val('qty-total')).toBe('0');
    plus('qty-evening');
    plus('qty-evening'); // 0 -> 0.5
    tap(screen.getByText(en.delivered));
    const e = lastEntry(fb, 'c1');
    expect([e.milkMorningL, e.milkEveningL, e.milkL]).toEqual([0.25, 0.5, 0.75]);
  });
  it('morning/evening +/- (no Total) adds both', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb)} />));
    // 1.10.27: the evening box starts empty (evening not delivered yet); fill it in
    fireEvent.change(box('qty-evening').querySelector('input'), { target: { value: '0.75' } });
    expect(screen.getByTestId('sum-box').textContent).toContain('1.75');
    tap(screen.getByText(en.delivered));
    const e = lastEntry(fb, 'c1');
    expect([e.milkMorningL, e.milkEveningL, e.milkL]).toEqual([1, 0.75, 1.75]);
  });
  it('Back on a total-only delivery re-opens it with the Total box filled', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb)} />));
    plus('qty-total');
    tap(screen.getByText(en.delivered));
    tap(screen.getAllByText(`← ${en.back}`).find((b) => b.closest('.deli-card')));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Asha');
    expect([val('qty-morning'), val('qty-evening'), val('qty-total')]).toEqual(['0', '0', '0.25']);
  });
});

describe('delivery sounds', () => {
  it('Delivered, As usual and Absent each play their own sound', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb)} />));
    tap(screen.getByText(en.delivered));
    tap(screen.getByText(en.asUsual, { selector: 'button' }));
    tap(screen.getByText(en.absent));
    expect(fx.sounds).toEqual(['delivered', 'usual', 'absent']);
  });
  it('a blocked double tap plays nothing', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb)} />));
    tap(screen.getByText(en.delivered));
    fireEvent.click(screen.getByText(en.delivered)); // within the guard
    expect(fx.sounds).toEqual(['delivered']);
  });
});

describe('delivery screen layout and list', () => {
  it('no Back button at the top (the card Back stays)', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb)} />));
    expect(document.querySelector('.screen-head').textContent).not.toContain(en.back);
    tap(screen.getByText(en.delivered));
    expect(screen.getAllByText(`← ${en.back}`).some((b) => b.closest('.deli-card'))).toBe(true);
  });
  it('suppliers are on the round in route-number order', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb)} />));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Asha');
    tap(screen.getByText(en.delivered));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Supplier Sharma');
    tap(screen.getByText(en.asUsual, { selector: 'button' }));
    expect(lastEntry(fb, 's1').milkL).toBe(20);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Bablu');
  });
  it('a morning entered in the Register keeps the customer on the round for the evening', () => {
    // 1.10.27: a saved split counts as the whole day (evening 0 = no evening milk); only a
    // morning-only Delivery save (half: 'morning') keeps the customer for the evening.
    expect(dayComplete({ milkL: 1, milkMorningL: 1, milkEveningL: 0 }, c1)).toBe(true);
    expect(dayComplete({ milkL: 1, milkMorningL: 1, milkEveningL: 0, half: 'morning' }, c1)).toBe(false);
    expect(dayComplete({ milkL: 1, milkMorningL: 1, milkEveningL: 0 }, c2)).toBe(true);
    expect(dayComplete({ milkL: 2, milkMorningL: 0, milkEveningL: 0 }, c1)).toBe(true);
    const fb = mkFb();
    const days = { [todayISO()]: { entries: { c1: { milkL: 1.5, milkMorningL: 1.5, milkEveningL: 0, half: 'morning' } } } };
    render(wrap(<Delivery {...props(fb, { days })} />));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Asha');
    expect([val('qty-morning'), val('qty-evening')]).toEqual(['1.5', '1']);
  });
  it('a paneer-only sale goes into history, so Back reaches it', () => {
    const fb = mkFb();
    render(wrap(<Delivery {...props(fb)} />));
    fireEvent.click(screen.getByTestId('paneer-toggle'));
    plus('qty-morning');
    minus('qty-morning');
    fireEvent.change(box('qty-morning').querySelector('input'), { target: { value: '0' } });
    fireEvent.change(box('qty-evening').querySelector('input'), { target: { value: '0' } });
    fireEvent.change(document.querySelector('.deli-card .deli-qty input'), { target: { value: '500' } }); // grams (1.10.14)
    tap(screen.getByText(en.delivered));
    expect(lastEntry(fb, 'c1').paneerKg).toBe(0.5);
    tap(screen.getAllByText(`← ${en.back}`).find((b) => b.closest('.deli-card')));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Asha');
  });
});

describe('"Everyone\'s usual" off keeps later corrections', () => {
  it('a customer corrected after the toggle is not reverted', () => {
    const fb = mkFb();
    const date = todayISO();
    const { rerender } = render(wrap(<Delivery {...props(fb, { days: { [date]: { entries: {} } } })} />));
    tap(screen.getByTestId('all-usual-toggle'));
    const written = dayWrites(fb)[0].data.entries;
    const corrected = { ...written, c1: { ...written.c1, milkMorningL: 0, milkEveningL: 0, milkL: 0, skip: true } };
    rerender(wrap(<Delivery {...props(fb, { days: { [date]: { entries: corrected } } })} />));
    tap(screen.getByTestId('all-usual-toggle'));
    const dels = fb.writes.filter((w) => w.update).map((w) => Object.keys(w.data).find((k) => k.startsWith('entries.'))).sort();
    expect(dels).toEqual(['entries.c2', 'entries.s1']);
  });
});

describe('Customers: last edited + save feedback', () => {
  it('Save plays the save sound and the customer row turns green; it stays after remount', () => {
    const fb = mkFb();
    const { unmount } = render(wrap(<Customers fb={fb} customers={[c1, c2]} settings={settings} openCustomer={() => {}} />));
    fireEvent.click(screen.getByText(/Bablu/));
    fireEvent.click(screen.getByText(en.save));
    expect(fx.sounds).toEqual(['save']);
    expect(screen.getByTestId('last-edited').textContent).toContain('Bablu');
    unmount();
    render(wrap(<Customers fb={fb} customers={[c1, c2]} settings={settings} openCustomer={() => {}} />));
    expect(screen.getByTestId('last-edited').textContent).toContain('Bablu');
  });
  it('Cancel does not move the highlight', () => {
    const fb = mkFb();
    render(wrap(<Customers fb={fb} customers={[c1, c2]} settings={settings} openCustomer={() => {}} />));
    fireEvent.click(screen.getByText(/Asha/));
    fireEvent.click(screen.getByText(en.cancel));
    expect(screen.queryByTestId('last-edited')).toBeNull();
  });
  it('a save that fails validation vibrates once and plays no sound', () => {
    const fb = mkFb();
    render(wrap(<Customers fb={fb} customers={[c1]} settings={settings} openCustomer={() => {}} />));
    fireEvent.click(screen.getByText(/Asha/));
    fireEvent.change(document.querySelector('form input'), { target: { value: '  ' } });
    fireEvent.click(screen.getByText(en.save));
    expect(fx.fails).toBe(1);
    expect(fx.sounds).toEqual([]);
  });
  it('every Save button is wired to the feedback', () => {
    const src = ['Customers', 'Settings', 'Register'].map((f) => readFileSync(`src/screens/${f}.jsx`, 'utf8'));
    src.forEach((s) => expect(s).toContain('saveFeedback(true)'));
    // Add payment has its own "cha-ching" + animation (1.10.12)
    expect(readFileSync('src/screens/CustomerDetail.jsx', 'utf8')).toContain("playSound('payment')");
    expect(readFileSync('src/db.js', 'utf8')).toContain('vibrateFail()');
    expect(readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8')).toContain('android.permission.VIBRATE');
  });
});

describe('scroll position is kept behind a sub-screen', () => {
  function Probe({ open }) {
    useScrollKeep(open);
    return <div />;
  }
  it('open goes to the top; closing restores where the list was, even after scrolling the form', () => {
    let y = 0;
    vi.spyOn(window, 'scrollTo').mockImplementation((_x, ny) => {
      y = ny;
      Object.defineProperty(window, 'scrollY', { value: ny, configurable: true });
    });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    const { rerender } = render(<Probe open={false} />);
    Object.defineProperty(window, 'scrollY', { value: 2400, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    rerender(<Probe open />);
    expect(y).toBe(0);
    Object.defineProperty(window, 'scrollY', { value: 300, configurable: true }); // scrolled the form
    window.dispatchEvent(new Event('scroll'));
    rerender(<Probe open={false} />);
    expect(y).toBe(2400);
  });
  it('a different tab after closing starts at the top', () => {
    let y = -1;
    vi.spyOn(window, 'scrollTo').mockImplementation((_x, ny) => {
      y = ny;
    });
    function P({ open, k }) {
      useScrollKeep(open, k);
      return null;
    }
    Object.defineProperty(window, 'scrollY', { value: 1800, configurable: true });
    const { rerender } = render(<P open={false} k="customers" />);
    rerender(<P open k="customers" />);
    rerender(<P open={false} k="register" />);
    expect(y).toBe(0);
  });
  it('is used by every screen that swaps its list for a sub-screen', () => {
    ['src/App.jsx', 'src/screens/Customers.jsx', 'src/screens/Hisaab.jsx', 'src/screens/RegisterView.jsx'].forEach((f) =>
      expect(readFileSync(f, 'utf8')).toContain('useScrollKeep('),
    );
  });
});

describe('Customers: three buttons in one row + search', () => {
  const c3 = { id: 'c3', name: 'Chandan', order: 30, area: 'Station road', phone: '94313 37743', usualMorningL: 1, usualEveningL: 0 };
  it('New / Bulk add / Select & tag sit together in one row', () => {
    render(wrap(<Customers fb={mkFb()} customers={[c1, c2]} settings={settings} openCustomer={() => {}} />));
    const btns = [...screen.getByTestId('cust-head-btns').querySelectorAll('button')].map((b) => b.textContent);
    expect(btns).toEqual([`+ ${en.addCustomer}`, `⇪ ${en.importTitle}`, en.selectTag]);
    expect(readFileSync('src/styles.css', 'utf8')).toMatch(/\.head-btns \{[^}]*repeat\(3, 1fr\)/);
  });
  it('search filters by name, area or phone, keeps the route numbers and turns ▲ / ▼ off', () => {
    const fb = mkFb();
    render(wrap(<Customers fb={fb} customers={[c1, c2, c3]} settings={settings} openCustomer={() => {}} />));
    const box = screen.getByLabelText(en.search);
    fireEvent.change(box, { target: { value: 'chan' } });
    const names = () => [...document.querySelectorAll('.cust-main b')].map((b) => b.textContent);
    expect(names()).toEqual(['3. Chandan']);
    expect(screen.getByLabelText(en.moveUp).disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'station' } });
    expect(names()).toEqual(['3. Chandan']);
    fireEvent.change(box, { target: { value: '7743' } });
    expect(names()).toEqual(['3. Chandan']);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText(en.noMatch)).toBeTruthy();
    fireEvent.change(box, { target: { value: '' } });
    expect(names()).toEqual(['1. Asha', '2. Bablu', '3. Chandan']);
  });
  it('the search stays after editing a customer and coming back', () => {
    render(wrap(<Customers fb={mkFb()} customers={[c1, c2, c3]} settings={settings} openCustomer={() => {}} />));
    fireEvent.change(screen.getByLabelText(en.search), { target: { value: 'bab' } });
    fireEvent.click(screen.getByText(/Bablu/));
    fireEvent.click(screen.getByText(en.save));
    expect(screen.getByLabelText(en.search).value).toBe('bab');
    expect([...document.querySelectorAll('.cust-main b')].map((b) => b.textContent)).toEqual(['2. Bablu']);
  });
});

describe('phone Back clears a typed search first', () => {
  it('Customers: Back empties the search and shows the full list; the next Back is the app\'s', () => {
    render(wrap(<Customers fb={mkFb()} customers={[c1, c2]} settings={settings} openCustomer={() => {}} />));
    fireEvent.change(screen.getByLabelText(en.search), { target: { value: 'bab' } });
    expect(document.querySelectorAll('.cust-main').length).toBe(1);
    let ran;
    act(() => {
      ran = handleBack();
    });
    expect(ran).toBe(true);
    expect(screen.getByLabelText(en.search).value).toBe('');
    expect(document.querySelectorAll('.cust-main').length).toBe(2);
    act(() => {
      ran = handleBack();
    });
    expect(ran).toBe(false);
  });
  it('Back closes the edit form before it clears the search', () => {
    render(wrap(<Customers fb={mkFb()} customers={[c1, c2]} settings={settings} openCustomer={() => {}} />));
    fireEvent.change(screen.getByLabelText(en.search), { target: { value: 'bab' } });
    fireEvent.click(screen.getByText(/Bablu/));
    act(() => {
      handleBack();
    });
    expect(screen.getByLabelText(en.search).value).toBe('bab');
    act(() => {
      handleBack();
    });
    expect(screen.getByLabelText(en.search).value).toBe('');
  });
  it('Register and Hisaab do the same', () => {
    render(wrap(<RegisterView fb={mkFb()} customers={[c1, c2]} days={{}} pendingDays={{}} settings={settings} displayName="x" />));
    const box = document.querySelector('input.search');
    fireEvent.change(box, { target: { value: 'ash' } });
    act(() => {
      expect(handleBack()).toBe(true);
    });
    expect(document.querySelector('input.search').value).toBe('');
    ['src/screens/Hisaab.jsx', 'src/screens/RegisterView.jsx', 'src/screens/Customers.jsx'].forEach((f) =>
      expect(readFileSync(f, 'utf8')).toContain("pushBackHandler(() => setQuery(''))"),
    );
  });
});

describe('start-up animation', () => {
  it('loading shows the milk-bottle splash with the app name and the loading text', async () => {
    const { default: Splash } = await import('../src/components/Splash.jsx');
    render(<Splash text="Loading…" />);
    const s = screen.getByTestId('splash');
    expect(s.querySelector('svg .splash-milk')).toBeTruthy();
    expect(s.textContent).toContain('Dairy Diary');
    expect(s.textContent).toContain('Loading…');
  });
  it('App uses it for every start-up wait, and index.html shows it before JavaScript runs', () => {
    const app = readFileSync('src/App.jsx', 'utf8');
    expect(app.match(/<Splash /g).length).toBe(3);
    expect(app).not.toContain(`<div className="center-screen">{t('loading')}</div>`);
    expect(readFileSync('index.html', 'utf8')).toContain('class="dd-boot"');
    expect(readFileSync('src/styles.css', 'utf8')).toContain('prefers-reduced-motion');
  });
});

describe('1.10.10 icons and launch screen', () => {
  it('Hisaab: WhatsApp button is only the WhatsApp logo, Bill photos has the bill icon', () => {
    const src = readFileSync('src/screens/Hisaab.jsx', 'utf8');
    expect(src).toContain('<WhatsAppIcon />');
    expect(src).toContain('<BillIcon />');
    expect(src).not.toContain("📲 {t('waBillsShort')}");
    expect(src).not.toContain('🖼️');
  });
  it('Android launch screen has no logo (blank icon, cream background)', () => {
    const st = readFileSync('android/app/src/main/res/values/styles.xml', 'utf8');
    expect(st).toContain('@drawable/splash_blank');
    expect(st).toContain('@drawable/splash_bg');
    expect(st).not.toContain('@drawable/splash<');
  });
});

describe('1.10.10 dates and first month', () => {
  it('dates read "15 October 2026"', async () => {
    const { dmy } = await import('../src/format.js');
    expect(dmy('2026-10-15')).toBe('15 October 2026');
    expect(dmy('2026-09-01', 'hi')).toBe('1 सितंबर 2026');
  });
  it('first delivery month ignores empty and skipped days', async () => {
    const { firstDeliveryMonth } = await import('../src/firstMonth.js');
    const days = {
      '2026-08-20': { entries: { a: { skip: true, milkL: 2 } } },
      '2026-09-30': { entries: { a: { milkL: 0 } } },
      '2026-10-01': { entries: { a: { milkL: 1.5 } } },
    };
    expect(firstDeliveryMonth(days)).toBe('2026-10');
    expect(firstDeliveryMonth({ ...days, '2026-09-05': { entries: { b: { paneerKg: 0.5 } } } })).toBe('2026-09');
  });
  it('the ◀ month arrow stops at the first delivery month', async () => {
    const { default: MonthNav } = await import('../src/components/MonthNav.jsx');
    const set = vi.fn();
    render(<MonthNav month="2026-09" setMonth={set} minMonth="2026-09" />);
    expect(screen.getAllByRole('button')[0].disabled).toBe(true);
  });
});
