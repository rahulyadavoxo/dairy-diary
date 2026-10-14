// v1.10.0: owner's UPI ID in Settings + amount QR in the customer's payment card.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../src/billImage.js', async (orig) => ({ ...(await orig()), renderBillImage: vi.fn(), shareImage: vi.fn() }));
vi.mock('../src/billCache.js', () => ({ getCachedPhoto: vi.fn(async () => null), putCachedPhoto: vi.fn() }));
vi.mock('../src/billPreGen.js', () => ({ preGenerateBillPhotos: vi.fn() }));

import { validUpiId, upiLink, qrDataUrl } from '../src/upi.js';
import CustomerDetail from '../src/screens/CustomerDetail.jsx';
import { LangContext, makeT, STRINGS } from '../src/i18n.js';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
const props = (settings) => ({
  fb: { farmId: 'f' }, days: {}, payments: [], displayName: 'x', customerId: 'c1', month: '2026-10',
  setMonth: () => {}, onBack: () => {}, customers: [{ id: 'c1', name: 'Ram', phone: '' }],
  settings: { milkRatePaise: 6000, paneerRatePaise: 40000, farmName: 'Yadav Dairy', ...settings },
});

beforeEach(() => cleanup());

describe('upi helpers', () => {
  it('validUpiId', () => {
    expect(validUpiId(' rahul@okaxis ')).toBe('rahul@okaxis');
    expect(validUpiId('98765.43210@ybl')).toBe('98765.43210@ybl');
    for (const v of ['', null, 'rahul', '@ybl', 'a@1bank', 'ra hul@ybl']) expect(validUpiId(v)).toBeNull();
  });
  it('upiLink has payee, amount in rupees, INR', () => {
    const l = upiLink({ upiId: 'rahul@okaxis', payeeName: 'Yadav Dairy', amountPaise: 1356750, note: 'Yadav Dairy - Ram' });
    expect(l).toBe('upi://pay?pa=rahul%40okaxis&pn=Yadav%20Dairy&am=13567.50&cu=INR&tn=Yadav%20Dairy%20-%20Ram');
    expect(upiLink({ upiId: 'rahul@okaxis', amountPaise: 0 })).toBeNull();
    expect(upiLink({ upiId: 'bad', amountPaise: 100 })).toBeNull();
  });
  it('qrDataUrl makes an image', () => {
    expect(qrDataUrl('upi://pay?pa=a@b&am=1.00')).toMatch(/^data:image\/(gif|png);base64,/);
  });
});

describe('UPI QR at the bottom of the customer page', () => {
  const withDue = (settings) => ({ ...props(settings), days: { '2026-10-01': { entries: { c1: { milkL: 2, milkRatePaise: 6000 } } } } });
  const amountBox = (c) => c.querySelector('form.pay input[type="number"]');

  it('no UPI ID: asks to set it in Settings', () => {
    render(wrap(<CustomerDetail {...withDue({})} />));
    expect(screen.getByText(en.upiNotSet)).toBeTruthy();
  });
  it('shows the full due by default, even in Cash mode, and is the last thing on the page', () => {
    const { container } = render(wrap(<CustomerDetail {...withDue({ upiId: 'rahul@okaxis' })} />));
    expect(screen.getByTestId('upi-qr-amount').textContent).toMatch(/120/);
    expect(screen.getByTestId('upi-qr').getAttribute('src')).toMatch(/^data:image/);
    expect(container.firstChild.lastElementChild.getAttribute('data-testid')).toBe('upi-qr-box');
  });
  it('follows the typed amount live and falls back to the due when cleared', () => {
    const { container } = render(wrap(<CustomerDetail {...withDue({ upiId: 'rahul@okaxis' })} />));
    const src0 = screen.getByTestId('upi-qr').getAttribute('src');
    fireEvent.change(amountBox(container), { target: { value: '50' } });
    expect(screen.getByTestId('upi-qr-amount').textContent).toMatch(/50/);
    const src1 = screen.getByTestId('upi-qr').getAttribute('src');
    expect(src1).not.toBe(src0);
    fireEvent.change(amountBox(container), { target: { value: '75.5' } });
    expect(screen.getByTestId('upi-qr-amount').textContent).toMatch(/75\.50/);
    expect(screen.getByTestId('upi-qr').getAttribute('src')).not.toBe(src1);
    fireEvent.change(amountBox(container), { target: { value: '' } });
    expect(screen.getByTestId('upi-qr').getAttribute('src')).toBe(src0);
  });
  it('nothing due and nothing typed: says so', () => {
    render(wrap(<CustomerDetail {...props({ upiId: 'rahul@okaxis' })} />));
    expect(screen.getByText(en.upiNoDue)).toBeTruthy();
  });
});
