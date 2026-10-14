import { describe, it, expect, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LangContext, loadLang, saveLang, makeT } from '../src/i18n.js';
import NotConfigured from '../src/screens/NotConfigured.jsx';
import { isFirebaseConfigured } from '../src/firebase.js';
import { STRINGS } from '../src/i18n.js';
import { billText, waLink } from '../src/bill.js';
import { computeMonth } from '../src/billing.js';

describe('Firebase placeholder detection', () => {
  it('rejects a placeholder-shaped config', () => {
    expect(
      isFirebaseConfigured({
        apiKey: 'PASTE_YOUR_API_KEY',
        authDomain: 'PASTE_YOUR_PROJECT.firebaseapp.com',
        projectId: 'PASTE_YOUR_PROJECT_ID',
        appId: 'PASTE_YOUR_APP_ID',
      }),
    ).toBe(false);
  });
  it('accepts the shipped config (real Firebase project)', () => {
    expect(isFirebaseConfigured()).toBe(true);
  });
  it('accepts a real-looking config', () => {
    expect(
      isFirebaseConfigured({ apiKey: 'AIzaSyA1b2c3', authDomain: 'dairy-123.firebaseapp.com', projectId: 'dairy-123', appId: '1:123:web:abc' }),
    ).toBe(true);
  });
  it('rejects empty or partial config', () => {
    expect(isFirebaseConfigured({})).toBe(false);
    expect(isFirebaseConfigured({ apiKey: 'AIzaSyA1b2c3', projectId: 'x-1234' })).toBe(false);
  });
});

function NotConfiguredHarness() {
  const [lang, setLangState] = useState(loadLang());
  const setLang = (l) => {
    saveLang(l);
    setLangState(l);
  };
  return (
    <LangContext.Provider value={{ lang, setLang, t: makeT(lang) }}>
      <NotConfigured />
    </LangContext.Provider>
  );
}

describe('Not-configured screen (smoke)', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });
  it('renders in Hindi by default, toggles to English and remembers it', () => {
    render(<NotConfiguredHarness />);
    expect(screen.getByTestId('not-configured')).toBeTruthy();
    expect(screen.getByText(STRINGS.hi.notConfiguredTitle)).toBeTruthy();
    fireEvent.click(screen.getByText(STRINGS.hi.langToggle));
    expect(screen.getByText(STRINGS.en.notConfiguredTitle)).toBeTruthy();
    expect(localStorage.getItem('dd_lang')).toBe('en');
    cleanup();
    render(<NotConfiguredHarness />);
    expect(screen.getByText(STRINGS.en.notConfiguredTitle)).toBeTruthy();
  });
});

describe('i18n completeness', () => {
  it('every key exists in both languages', () => {
    expect(Object.keys(STRINGS.hi).sort()).toEqual(Object.keys(STRINGS.en).sort());
  });
});

describe('WhatsApp bill', () => {
  it('builds a bilingual bill with rupee amounts and a wa.me link', () => {
    const res = computeMonth({
      customers: [{ id: 'a', name: 'Amit', openingDuePaise: 10000 }],
      days: { '2026-10-01': { entries: { a: { milkL: 2, milkRatePaise: 6000 } } }, '2026-10-02': { entries: { a: { milkL: 1.5, paneerKg: 0.5, milkRatePaise: 6000, paneerRatePaise: 40000 } } } },
      payments: [{ customerId: 'a', date: '2026-10-05', amountPaise: 5000 }],
      settings: { milkRatePaise: 6000, paneerRatePaise: 40000, farmName: 'Yadav Dairy', phone: '9876543210' },
      month: '2026-10',
    });
    const txt = billText(res.rows[0], '2026-10', { farmName: 'Yadav Dairy', phone: '9876543210' });
    expect(txt).toContain('Yadav Dairy');
    expect(txt).toContain('अक्टूबर 2026');
    expect(txt).toContain('October 2026');
    expect(txt).toContain('3.5 L × ₹60 = ₹210');
    expect(txt).toContain('₹200'); // paneer
    expect(txt).toContain('Balance due: ₹460'); // 100 + 410 - 50
    const link = waLink('98765 43210', txt);
    expect(link.startsWith('https://wa.me/919876543210?text=')).toBe(true);
  });
});
