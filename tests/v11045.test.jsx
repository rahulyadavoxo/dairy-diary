import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../src/billImage.js', async (orig) => ({ ...(await orig()), renderBillImage: vi.fn(async () => new Blob(['x'])) }));
vi.mock('../src/billCache.js', () => ({ getCachedPhoto: vi.fn(async () => null), putCachedPhoto: vi.fn(), deleteCachedPhoto: vi.fn() }));
const sent = [];
vi.mock('../src/waShare.js', async (orig) => ({
  ...(await orig()),
  sendBillToWhatsApp: vi.fn(async ({ phone }) => {
    sent.push(phone);
    return 'direct';
  }),
}));

import BillSender, { CHAIN_SECONDS } from '../src/screens/BillSender.jsx';
import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import { addMonths, monthOf, todayISO } from '../src/format.js';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};

describe('1.10.45 bills one by one: next chat opens after coming back', () => {
  beforeEach(() => {
    sent.length = 0;
    localStorage.clear();
    globalThis.URL.createObjectURL = () => 'blob:x';
    globalThis.URL.revokeObjectURL = () => {};
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  const bm = addMonths(monthOf(todayISO()), -1);
  const customers = [
    { id: 'a', name: 'Asha', phone: '9876543210', order: 10 },
    { id: 'b', name: 'Bina', phone: '9876543211', order: 20 },
  ];
  const days = { [`${bm}-05`]: { entries: { a: { milkL: 1 }, b: { milkL: 1 } } } };
  const props = { fb: {}, customers, days, payments: [], settings: { milkRatePaise: 6000 }, onClose: () => {} };

  it('share -> back -> countdown -> next chat opens; Stop cancels', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(wrap(<BillSender {...props} />));
    await flush();
    fireEvent.click(screen.getByText(/Send bills to everyone/));
    await flush();
    expect(sent).toHaveLength(1);
    // back from WhatsApp
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByTestId('chain-countdown').textContent).toContain(String(CHAIN_SECONDS));
    for (let i = 0; i < CHAIN_SECONDS; i++) await act(async () => vi.advanceTimersByTime(1000));
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
  });

  it('Stop keeps the next chat closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(wrap(<BillSender {...props} />));
    await flush();
    fireEvent.click(screen.getByText(/Send bills to everyone/));
    await flush();
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    fireEvent.click(screen.getByText(new RegExp(en.waChainStop)));
    for (let i = 0; i < CHAIN_SECONDS + 1; i++) await act(async () => vi.advanceTimersByTime(1000));
    await flush();
    expect(sent).toHaveLength(1);
    expect(screen.queryByTestId('chain-countdown')).toBeNull();
  });
});
