import { describe, it, expect, beforeEach } from 'vitest';
import { listAnimOn, setListAnim, applyListAnim } from '../src/listAnim.js';

describe('1.10.40 list animation switch', () => {
  beforeEach(() => localStorage.clear());
  it('is on by default and toggles the html class', () => {
    expect(listAnimOn()).toBe(true);
    applyListAnim();
    expect(document.documentElement.classList.contains('list-anim')).toBe(true);
    setListAnim(false);
    expect(listAnimOn()).toBe(false);
    expect(document.documentElement.classList.contains('list-anim')).toBe(false);
    setListAnim(true);
    expect(document.documentElement.classList.contains('list-anim')).toBe(true);
  });
});
