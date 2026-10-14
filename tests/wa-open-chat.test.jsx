// v1.10.3: "Open chat" button for customers with no earlier WhatsApp chat
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const calls = vi.hoisted(() => []);
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({ openChat: async (a) => calls.push(a), shareImage: async () => {} }),
}));

import WaDirectHelp from '../src/components/WaDirectHelp.jsx';
import { LangContext, makeT, STRINGS } from '../src/i18n.js';

describe('WaDirectHelp', () => {
  it('explains the first-chat rule and opens the chat with the number only', () => {
    render(
      <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>
        <WaDirectHelp phone="918877005045" />
      </LangContext.Provider>,
    );
    expect(screen.getByText(STRINGS.en.waDirectHint2)).toBeTruthy();
    fireEvent.click(screen.getByText(/Open chat \+918877005045/));
    expect(calls).toEqual([{ phone: '918877005045' }]);
  });
});
