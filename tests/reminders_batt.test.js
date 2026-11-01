import { describe, it, expect } from 'vitest';
import { batteryExempt, askBatteryExempt } from '../src/reminders.js';
describe('battery exemption on web', () => {
  it('is unknown without the native plugin', async () => {
    expect(await batteryExempt()).toBeNull();
    expect(await askBatteryExempt()).toBeNull();
  });
});
