import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { readProgress, progKey } from '../src/screens/BillSender.jsx';
import { billAsOfText } from '../src/billImage.js';
import { chunkList, SHARE_CHUNK } from '../src/waShare.js';

const J = 'android/app/src/main/java/in/dairydiary/app/';
beforeEach(() => localStorage.clear());

describe('HIGH: per-month bill progress', () => {
  it('a mid-month run (15 Nov) is never resumed as the final Nov bill on 1 Dec', () => {
    localStorage.setItem(progKey('2026-11'), JSON.stringify({ month: '2026-11', past: false, day: '2026-11-15', idx: 3, curId: 'after:c' }));
    expect(readProgress('2026-11', true, '2026-12-01')).toBeNull();
  });
  it('a mid-month run resumes only on the same day', () => {
    localStorage.setItem(progKey('2026-11'), JSON.stringify({ month: '2026-11', past: false, day: '2026-11-15', idx: 1 }));
    expect(readProgress('2026-11', false, '2026-11-15')).toBeTruthy();
    expect(readProgress('2026-11', false, '2026-11-16')).toBeNull();
  });
  it('October final progress and November mid-month progress live side by side', () => {
    localStorage.setItem(progKey('2026-10'), JSON.stringify({ month: '2026-10', past: true, idx: 5 }));
    localStorage.setItem(progKey('2026-11'), JSON.stringify({ month: '2026-11', past: false, day: '2026-11-02', idx: 1 }));
    expect(readProgress('2026-10', true, '2026-11-02').idx).toBe(5);
    expect(readProgress('2026-11', false, '2026-11-02').idx).toBe(1);
  });
});

describe('LOW fixes', () => {
  it('current-month bill shows "till date"; past month does not', () => {
    expect(billAsOfText('2026-11', '2026-11-20')).toContain('till 20');
    expect(billAsOfText('2026-10', '2026-11-20')).toBe('');
  });
  it('download all splits into parts of 20', () => {
    expect(SHARE_CHUNK).toBe(20);
    expect(chunkList(Array.from({ length: 45 }, (_, i) => i)).map((c) => c.length)).toEqual([20, 20, 5]);
  });
  it('native sources: saveBill + names, cached pool, alarm clock restore', () => {
    const wa = readFileSync(J + 'WhatsAppSharePlugin.java', 'utf8');
    const rx = readFileSync(J + 'RingReceiver.java', 'utf8');
    expect(wa).toContain('public void saveBill(PluginCall call)');
    expect(wa).toContain('call.getArray("names")');
    expect(wa).toContain('[A-Za-z0-9._-]+');
    expect(rx).toContain('Executors.newCachedThreadPool()');
    expect(rx).not.toContain('newSingleThreadExecutor');
    expect(rx).toContain('setAlarmClock(new AlarmManager.AlarmClockInfo(at, showPi), pi)');
  });
});
