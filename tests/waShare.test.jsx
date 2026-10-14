// Tests for direct WhatsApp bill sharing (photo only, no text).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

// ---- Mock @capacitor/core BEFORE waShare.js uses it (vi.mock is hoisted) ----
const mockState = vi.hoisted(() => ({ calls: [], rejectOnce: null }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({
    shareImage: (...args) => {
      mockState.calls.push(args);
      if (mockState.rejectOnce) {
        const e = mockState.rejectOnce;
        mockState.rejectOnce = null;
        return Promise.reject(e);
      }
      return Promise.resolve({});
    },
  }),
}));

// ---- Mock bill render/cache so no canvas is needed ----
vi.mock('../src/billImage.js', async (orig) => {
  const m = await orig();
  return {
    ...m,
    renderBillImage: vi.fn().mockResolvedValue(new Blob(['x'], { type: 'image/png' })),
    billFingerprint: vi.fn().mockReturnValue('fp'),
  };
});
vi.mock('../src/billCache.js', () => ({
  getCachedPhoto: vi.fn().mockResolvedValue(null),
  putCachedPhoto: vi.fn().mockResolvedValue(undefined),
}));

import { validWaNumber, sendBillToWhatsApp } from '../src/waShare.js';
import { LangContext, makeT } from '../src/i18n.js';
import CustomerDetail from '../src/screens/CustomerDetail.jsx';

const wrap = (ui) => (
  <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>
);

const settings = { milkRatePaise: 6000, paneerRatePaise: 40000, farmName: 'F', phone: '' };
const mkCustomer = (phone) => ({ id: 'c1', name: 'Ramu', phone, active: true });
const props = (phone) => ({
  fb: null,
  customers: [mkCustomer(phone)],
  days: {},
  payments: [],
  settings,
  displayName: 'T',
  customerId: 'c1',
  month: '2026-09',
  setMonth: () => {},
  onBack: () => {},
});

describe('validWaNumber', () => {
  it('normalises Indian numbers', () => {
    expect(validWaNumber('9876543210')).toBe('919876543210');
    expect(validWaNumber('+91 98765-43210')).toBe('919876543210');
    expect(validWaNumber('09876543210')).toBe('919876543210');
  });
  it('rejects missing or invalid numbers', () => {
    expect(validWaNumber('')).toBe(null);
    expect(validWaNumber(null)).toBe(null);
    expect(validWaNumber('12345')).toBe(null);
    expect(validWaNumber('5876543210')).toBe(null); // bad series
  });
});

describe('sendBillToWhatsApp (native)', () => {
  beforeEach(() => { mockState.calls.length = 0; mockState.rejectOnce = null; });
  afterEach(() => cleanup());

  it('sends photo only, no text key, returns direct', async () => {
    const blob = new Blob(['img'], { type: 'image/png' });
    const r = await sendBillToWhatsApp({ blob, fileName: 'bill.png', phone: '919876543210' });
    expect(r).toBe('direct');
    expect(mockState.calls).toHaveLength(1);
    const arg = mockState.calls[0][0];
    expect(arg.phone).toBe('919876543210');
    expect(arg.fileName).toBe('bill.png');
    expect(typeof arg.base64).toBe('string');
    expect('text' in arg).toBe(false);
    expect('message' in arg).toBe(false);
  });

  it('sends phone undefined and returns picker when no number', async () => {
    const blob = new Blob(['img'], { type: 'image/png' });
    const r = await sendBillToWhatsApp({ blob, fileName: 'bill.png', phone: null });
    expect(r).toBe('picker');
    const arg = mockState.calls[0][0];
    expect(arg.phone).toBe(undefined);
  });

  it('propagates NOT_INSTALLED with its code', async () => {
    const err = new Error('nope');
    err.code = 'NOT_INSTALLED';
    mockState.rejectOnce = err;
    const blob = new Blob(['img'], { type: 'image/png' });
    await expect(sendBillToWhatsApp({ blob, fileName: 'b.png', phone: '919876543210' }))
      .rejects.toMatchObject({ code: 'NOT_INSTALLED' });
  });
});

describe('CustomerDetail WhatsApp share', () => {
  beforeEach(() => { mockState.calls.length = 0; mockState.rejectOnce = null; });
  afterEach(() => cleanup());

  it('no phone: shows wa-no-number, does not call plugin; picker button calls with phone undefined', async () => {
    render(wrap(<CustomerDetail {...props('')} />));
    fireEvent.click(screen.getByText('Share bill on WhatsApp'));
    expect(await screen.findByTestId('wa-no-number')).toBeTruthy();
    expect(mockState.calls).toHaveLength(0);
    fireEvent.click(screen.getByText('Choose the customer in WhatsApp'));
    await waitFor(() => expect(mockState.calls).toHaveLength(1));
    expect(mockState.calls[0][0].phone).toBe(undefined);
  });

  it('valid phone: one click calls plugin with normalised number', async () => {
    render(wrap(<CustomerDetail {...props('9876543210')} />));
    fireEvent.click(screen.getByText('Share bill on WhatsApp'));
    await waitFor(() => expect(mockState.calls).toHaveLength(1));
    expect(mockState.calls[0][0].phone).toBe('919876543210');
  });

  it('plugin failure shows shareFailed and never sets a wa.me URL', async () => {
    const err = new Error('fail');
    err.code = 'SHARE_FAILED';
    mockState.rejectOnce = err;
    const origHref = window.location.href;
    render(wrap(<CustomerDetail {...props('9876543210')} />));
    fireEvent.click(screen.getByText('Share bill on WhatsApp'));
    await waitFor(() => expect(screen.getByText('Share failed, try again')).toBeTruthy());
    expect(window.location.href).toBe(origHref);
    expect(window.location.href).not.toContain('wa.me');
  });
});
