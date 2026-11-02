import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { LangContext, makeT, STRINGS } from '../src/i18n.js';
import Login, { PRIVACY_URL, TERMS_URL } from '../src/screens/Login.jsx';
import { AutoBillCard } from '../src/screens/Settings.jsx';

const en = STRINGS.en;
const wrap = (ui) => <LangContext.Provider value={{ lang: 'en', t: makeT('en'), setLang: () => {} }}>{ui}</LangContext.Provider>;
afterEach(() => cleanup());

const authFb = () => ({
  auth: {},
  authMod: {
    signInWithEmailAndPassword: vi.fn(async () => ({})),
    createUserWithEmailAndPassword: vi.fn(async () => ({})),
    sendPasswordResetEmail: vi.fn(async () => {}),
  },
});
const type = (el, v) => fireEvent.change(el, { target: { value: v } });

describe('sign-up', () => {
  it('Hindi and English have every new string', () => {
    for (const k of ['signupTitle', 'signupBtn', 'newDairySignup', 'forgotPass', 'autoBillTitle', 'autoBillSave']) {
      expect(STRINGS.hi[k]).toBeTruthy();
      expect(STRINGS.en[k]).toBeTruthy();
    }
  });
  it('creates an account only with matching passwords and the terms accepted', async () => {
    const fb = authFb();
    const { container } = render(wrap(<Login fb={fb} />));
    fireEvent.click(screen.getByTestId('toggle-signup'));
    expect(screen.getByText(en.signupTitle)).toBeTruthy();
    const [email, p1, p2] = container.querySelectorAll('input:not([type="checkbox"])');
    type(email, 'new@dairy.in');
    type(p1, 'secret1');
    type(p2, 'secret2');
    fireEvent.click(screen.getByTestId('signup-submit'));
    expect(screen.getByText(en.signupPassMismatch)).toBeTruthy();
    type(p2, 'secret1');
    fireEvent.click(screen.getByTestId('signup-submit'));
    expect(screen.getByText(en.signupAgreeFirst)).toBeTruthy();
    expect(fb.authMod.createUserWithEmailAndPassword).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('signup-agree'));
    fireEvent.click(screen.getByTestId('signup-submit'));
    await waitFor(() => expect(fb.authMod.createUserWithEmailAndPassword).toHaveBeenCalledWith(fb.auth, 'new@dairy.in', 'secret1'));
    expect(fb.authMod.signInWithEmailAndPassword).not.toHaveBeenCalled();
  });
  it('email already used shows a clear message', async () => {
    const fb = authFb();
    fb.authMod.createUserWithEmailAndPassword.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'auth/email-already-in-use' }));
    const { container } = render(wrap(<Login fb={fb} />));
    fireEvent.click(screen.getByTestId('toggle-signup'));
    const [email, p1, p2] = container.querySelectorAll('input:not([type="checkbox"])');
    type(email, 'a@b.in');
    type(p1, 'secret1');
    type(p2, 'secret1');
    fireEvent.click(screen.getByTestId('signup-agree'));
    fireEvent.click(screen.getByTestId('signup-submit'));
    expect(await screen.findByText(new RegExp(en.signupEmailUsed.slice(0, 20)))).toBeTruthy();
  });
  it('privacy and terms links point to the public pages', () => {
    render(wrap(<Login fb={authFb()} />));
    fireEvent.click(screen.getByTestId('toggle-signup'));
    expect(screen.getByText(en.privacyPolicy).getAttribute('href')).toBe(PRIVACY_URL);
    expect(screen.getByText(en.termsOfUse).getAttribute('href')).toBe(TERMS_URL);
    expect(readFileSync('docs/privacy.html', 'utf8')).toContain('rahulkumaryadav7090@gmail.com');
    expect(readFileSync('docs/terms.html', 'utf8')).toContain('Rahul Kumar');
  });
  it('forgot password needs the email and sends the reset link', async () => {
    const fb = authFb();
    const { container } = render(wrap(<Login fb={fb} />));
    fireEvent.click(screen.getByTestId('forgot-pass'));
    expect(screen.getByText(en.forgotNeedEmail)).toBeTruthy();
    type(container.querySelector('input[type="email"]'), 'o@d.in');
    fireEvent.click(screen.getByTestId('forgot-pass'));
    await waitFor(() => expect(fb.authMod.sendPasswordResetEmail).toHaveBeenCalledWith(fb.auth, 'o@d.in'));
    expect(await screen.findByText(en.forgotSent)).toBeTruthy();
  });
  it('normal sign-in still works', async () => {
    const fb = authFb();
    const { container } = render(wrap(<Login fb={fb} />));
    const [email, p1] = container.querySelectorAll('input');
    type(email, 'o@d.in');
    type(p1, 'pw');
    fireEvent.click(screen.getByTestId('login-submit'));
    await waitFor(() => expect(fb.authMod.signInWithEmailAndPassword).toHaveBeenCalled());
  });
  it('rules: any email/password account may create its own farm', () => {
    const r = readFileSync('firestore.rules', 'utf8');
    const fn = r.slice(r.indexOf('function isOwnerAccount()'), r.indexOf('function devDiff()'));
    expect(fn).not.toContain('ownerEmail()');
    expect(r).toContain('farmId == uid');
  });
});

describe('auto-bill settings', () => {
  const mk = () => {
    const writes = [];
    return {
      writes,
      farmId: 'f',
      fsMod: {
        doc: (_db, ...p) => ({ path: p.join('/') }),
        setDoc: vi.fn(async (r, data) => writes.push({ path: r.path, data })),
      },
    };
  };
  it('saves enabled/day/time into settings.autoBill and warns WhatsApp is not connected', () => {
    const fb = mk();
    render(wrap(<AutoBillCard fb={fb} settings={{}} />));
    expect(screen.getByTestId('autobill-save').className).toContain('saved-btn');
    fireEvent.click(screen.getByTestId('autobill-on'));
    fireEvent.change(screen.getByTestId('autobill-day'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('autobill-time'), { target: { value: '08:30' } });
    expect(screen.getByText(en.autoBillPending)).toBeTruthy();
    fireEvent.click(screen.getByTestId('autobill-save'));
    const w = fb.writes.at(-1);
    expect(w.data).toEqual({ autoBill: { enabled: true, day: 2, time: '08:30' } });
  });
});
