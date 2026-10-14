import { describe, it, expect, vi, beforeEach } from 'vitest';
const nat = vi.hoisted(() => ({ native: false, vib: vi.fn(async () => {}) }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => nat.native } }));
vi.mock('@capacitor/haptics', () => ({ Haptics: { vibrate: (...a) => nat.vib(...a) } }));
import { playSound, vibrateFail, saveFeedback } from '../src/feedback.js';

function fakeAudio() {
  const made = [];
  class AC {
    constructor() {
      this.currentTime = 0;
      this.state = 'running';
      this.destination = {};
    }
    createOscillator() {
      const o = { type: '', frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: (g) => g, start: vi.fn(), stop: vi.fn() };
      made.push(o);
      return o;
    }
    createGain() {
      return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: () => {} };
    }
  }
  window.AudioContext = AC;
  return made;
}

describe('feedback', () => {
  beforeEach(() => {
    nat.native = false;
    nat.vib.mockClear();
  });
  it('each delivery sound is different', () => {
    const made = fakeAudio();
    const sig = (n) => {
      const start = made.length;
      playSound(n);
      return made.slice(start).map((o) => o.type + o.frequency.setValueAtTime.mock.calls.map((c) => c[0]).join(',')).join('|');
    };
    const s = ['delivered', 'usual', 'absent', 'save'].map(sig);
    s.forEach((x) => expect(x).not.toBe(''));
    expect(new Set(s).size).toBe(4);
  });
  it('a failed save vibrates once: native Haptics on the phone, navigator.vibrate on web', () => {
    nat.native = true;
    vibrateFail();
    expect(nat.vib).toHaveBeenCalledWith({ duration: 250 });
    nat.native = false;
    navigator.vibrate = vi.fn();
    expect(saveFeedback(false)).toBe(false);
    expect(navigator.vibrate).toHaveBeenCalledTimes(1);
  });
  it('no audio support never throws', () => {
    delete window.AudioContext;
    expect(() => playSound('save')).not.toThrow();
  });
});
