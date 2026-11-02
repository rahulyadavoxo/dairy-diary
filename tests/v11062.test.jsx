import { describe, it, expect, vi, afterEach } from 'vitest';
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
  it('owner connects with Phone number ID + token through the waConnect function', async () => {
    const callFn = vi.fn(async () => ({ display: 'Yadav Dairy +91 98765' }));
    render(wrap(<AutoBillCard fb={fb} settings={{}} farmId="f" isOwner callFn={callFn} />));
    fireEvent.click(screen.getByTestId('wa-connect'));
    fireEvent.change(screen.getByTestId('wa-pnid'), { target: { value: '123456789' } });
    fireEvent.change(screen.getByTestId('wa-token'), { target: { value: 'EAAG-secret-token-xxxxxxxx' } });
    fireEvent.click(screen.getByTestId('wa-connect-submit'));
    await waitFor(() => expect(callFn).toHaveBeenCalledWith('waConnect', { farmId: 'f', phoneNumberId: '123456789', accessToken: 'EAAG-secret-token-xxxxxxxx', templateName: 'dd_bill', templateLang: 'hi' }));
    expect(await screen.findByText(/Yadav Dairy \+91 98765/)).toBeTruthy();
  });
  it('a joined phone cannot connect; connected state shows last run and test send', async () => {
    const { unmount } = render(wrap(<AutoBillCard fb={fb} settings={{}} farmId="f" isOwner={false} callFn={vi.fn()} />));
    expect(screen.queryByTestId('wa-connect')).toBeNull();
    expect(screen.getByText(en.waOwnerOnly)).toBeTruthy();
    unmount();
    const callFn = vi.fn(async () => ({ id: 'x' }));
    render(wrap(<AutoBillCard fb={fb} settings={{ autoBill: { connected: true, display: 'D', lastRun: { month: '2026-10', sent: 40, failed: 2 } } }} farmId="f" isOwner callFn={callFn} />));
    expect(screen.getByTestId('autobill-lastrun').textContent).toContain('✓ 40');
    fireEvent.change(screen.getByTestId('wa-test-phone'), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByTestId('wa-test'));
    await waitFor(() => expect(callFn).toHaveBeenCalledWith('waTest', { farmId: 'f', phone: '9876543210' }));
  });
  it('a function error is shown', async () => {
    const callFn = vi.fn(async () => {
      throw new Error('FirebaseError: WhatsApp: 190: Invalid OAuth access token');
    });
    render(wrap(<AutoBillCard fb={fb} settings={{}} farmId="f" isOwner callFn={callFn} />));
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
  it('functions reuse the shared bill code and the client never reads waPrivate', () => {
    const fn = readFileSync('functions/index.js', 'utf8');
    expect(fn).toContain("from './shared/billing.js'");
    expect(readFileSync('firestore.rules', 'utf8')).not.toContain('waPrivate');
    expect(readFileSync('docs/download.html', 'utf8')).toContain('releases/latest');
  });
});
