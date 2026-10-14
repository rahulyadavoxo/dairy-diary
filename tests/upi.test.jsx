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

describe('payment card QR', () => {
  it('cash: no QR box', () => {
    render(wrap(<CustomerDetail {...props({ upiId: 'rahul@okaxis' })} />));
    expect(screen.queryByTestId('upi-qr-box')).toBeNull();
  });
  it('UPI without an ID asks to set it in Settings', () => {
    render(wrap(<CustomerDetail {...props({})} />));
    fireEvent.click(screen.getByText(/UPI/, { selector: 'button' }));
    expect(screen.getByText(en.upiNotSet)).toBeTruthy();
  });
  it('UPI + amount shows the QR with the amount, after the Add payment button', () => {
    const { container } = render(wrap(<CustomerDetail {...props({ upiId: 'rahul@okaxis' })} />));
    fireEvent.click(screen.getByText(/UPI/, { selector: 'button' }));
    expect(screen.getByText(en.upiEnterAmount)).toBeTruthy();
    fireEvent.change(container.querySelector('form.pay input[type="number"]'), { target: { value: '250' } });
    expect(screen.getByTestId('upi-qr').getAttribute('src')).toMatch(/^data:image/);
    expect(screen.getByText('rahul@okaxis')).toBeTruthy();
    const form = container.querySelector('form.pay');
    expect(form.lastElementChild.getAttribute('data-testid')).toBe('upi-qr-box');
  });
});
