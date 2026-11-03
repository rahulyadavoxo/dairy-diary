import { addMonths, monthOf, todayISO } from './format.js';

/** Earliest month (YYYY-MM) in which any customer got milk or paneer. The ◀ arrows never go before
    it, so empty months before the dairy started using the app are not shown. With no delivery at
    all yet, the current month. */
export function firstDeliveryMonth(days) {
  let first = null;
  for (const iso of Object.keys(days || {})) {
    if (first && iso >= first) continue;
    const entries = (days[iso] && days[iso].entries) || {};
    const delivered = Object.values(entries).some(
      (en) => en && !en.skip && (Number(en.milkL) > 0 || Number(en.paneerKg) > 0),
    );
    if (delivered) first = iso;
  }
  const cur = monthOf(todayISO());
  if (!first) return cur;
  const m = monthOf(first);
  return m < cur ? m : cur;
}

/**
 * Month a customer page opens on (user, 3 Nov 2026): the month BEFORE the running month,
 * since that is the bill being collected. Falls back to the running month when the farm
 * has no deliveries before it (a brand-new farm).
 */
export function defaultCustomerMonth(days) {
  const cur = monthOf(todayISO());
  const prev = addMonths(cur, -1);
  return firstDeliveryMonth(days) <= prev ? prev : cur;
}
