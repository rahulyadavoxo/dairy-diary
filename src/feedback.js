// Tap feedback: short synthesized sounds (no audio files) and a vibration when a save fails.
// Sounds: 'save' (two-note "ting"), 'delivered' (bright ding), 'usual' (two quick taps),
// 'absent' (low falling tone). All play only from a user tap (WebView autoplay rules).

import { Capacitor } from '@capacitor/core';
import { Haptics } from '@capacitor/haptics';

let ctx = null;
function audio() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

// [frequency Hz, start s, length s, wave, end frequency?]
const SOUNDS = {
  save: [
    [880, 0, 0.12, 'sine'],
    [1320, 0.1, 0.22, 'sine'],
  ],
  delivered: [[1175, 0, 0.25, 'triangle']],
  usual: [
    [660, 0, 0.09, 'square'],
    [660, 0.13, 0.09, 'square'],
  ],
  absent: [[330, 0, 0.32, 'sawtooth', 180]],
};

export function playSound(name) {
  const notes = SOUNDS[name];
  const ac = notes && audio();
  if (!ac) return;
  try {
    const t0 = ac.currentTime + 0.01;
    notes.forEach(([f, start, len, type, fEnd]) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f, t0 + start);
      if (fEnd) osc.frequency.exponentialRampToValueAtTime(fEnd, t0 + start + len);
      const peak = type === 'sine' || type === 'triangle' ? 0.35 : 0.12;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + len);
      osc.connect(gain).connect(ac.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + len + 0.02);
    });
  } catch {
    /* sound is optional */
  }
}

function webVibrate() {
  try {
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(250);
  } catch {
    /* ignore */
  }
}

/** One vibration: the save did not happen (bad input, or the server refused the write).
    On the phone the native Haptics plugin vibrates (reliable in the WebView); web falls back. */
export function vibrateFail() {
  try {
    if (Capacitor.isNativePlatform && Capacitor.isNativePlatform() && Haptics && Haptics.vibrate) {
      const p = Haptics.vibrate({ duration: 250 });
      if (p && p.catch) p.catch(webVibrate);
      return;
    }
  } catch {
    /* fall back below */
  }
  webVibrate();
}

/** Save button pressed: ok -> "ting", not ok -> one vibration. Returns ok. */
export function saveFeedback(ok) {
  if (ok) playSound('save');
  else vibrateFail();
  return ok;
}
