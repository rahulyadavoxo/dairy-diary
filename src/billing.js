// Billing math. ALL money is integer paise; ALL quantities are integer
// millilitres (milk) and grams (paneer). No floating-point money anywhere.
//
// Inputs
//   customers: [{ id, openingDuePaise?, rateOverridePaise? }]
//   days:      { 'yyyy-mm-dd': { entries: { [customerId]: Entry } } }
//              Entry = { milkL, paneerKg, skip, milkRatePaise?, paneerRatePaise? }
//              (rates are snapshotted on the entry when it is saved, so changing
//               the rate later does not rewrite old bills)
//   payments:  [{ customerId, date: 'yyyy-mm-dd', amountPaise }]
//   settings:  { milkRatePaise, paneerRatePaise }

/** litres/kg (number or string) -> integer milli-units (ml / g) */
export function toMilli(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1000);
}

/** quantity in milli-units * rate per unit (paise) -> paise, rounded to nearest paisa */
export function amountPaise(qtyMilli, ratePaise) {
  return Math.round((qtyMilli * (ratePaise || 0)) / 1000);
}

/** A usable rate: a whole number of paise above zero. 0 / null / NaN mean "no rate". */
export const validRate = (x) => Number.isInteger(x) && x > 0;

// An entry saved before any rate was set used to snapshot milkRatePaise: 0 and was then billed
// ₹0 forever. A 0 / invalid snapshot is ignored, so those days fall back to the customer's
// special rate or the current settings rate (fixes old entries without a data migration).
export function milkRateFor(customer, settings, entry) {
  if (entry && validRate(entry.milkRatePaise)) return entry.milkRatePaise;
  if (customer && validRate(customer.rateOverridePaise)) return customer.rateOverridePaise;
  return settings && validRate(settings.milkRatePaise) ? settings.milkRatePaise : 0;
}

export function paneerRateFor(settings, entry) {
  if (entry && validRate(entry.paneerRatePaise)) return entry.paneerRatePaise;
  return settings && validRate(settings.paneerRatePaise) ? settings.paneerRatePaise : 0;
}

/** Charge for a single saved entry. Skip = no milk that day (paneer still counts if entered). */
export function entryCharge(entry, customer, settings) {
  if (!entry) return { milkMl: 0, milkPaise: 0, paneerG: 0, paneerPaise: 0, totalPaise: 0, milkRatePaise: 0 };
  const milkMl = entry.skip ? 0 : toMilli(entry.milkL);
  const paneerG = toMilli(entry.paneerKg);
  const mr = milkRateFor(customer, settings, entry);
  const pr = paneerRateFor(settings, entry);
  const milkPaise = amountPaise(milkMl, mr);
  const paneerPaise = amountPaise(paneerG, pr);
  return { milkMl, milkPaise, paneerG, paneerPaise, totalPaise: milkPaise + paneerPaise, milkRatePaise: mr, paneerRatePaise: pr };
}

function emptyRow(customer) {
  return {
    customerId: customer.id,
    customer,
    previousDuePaise: customer.openingDuePaise || 0,
    milkMl: 0,
    milkPaise: 0,
    paneerG: 0,
    paneerPaise: 0,
    billedPaise: 0,
    paidPaise: 0,
    balancePaise: 0,
    milkRates: new Set(),
    daily: {}, // date -> { milkMl, paneerG, skip, totalPaise }
    payments: [],
    hasActivity: false,
  };
}

/**
 * Compute the month's hisaab for every customer.
 * previousDue = openingDue + everything billed before the month - everything paid before the month
 * balance     = previousDue + billed this month - paid this month
 */
export function computeMonth({ customers = [], days = {}, payments = [], settings = {}, month }) {
  const start = `${month}-01`;
  const end = `${month}-31`; // string compare: any yyyy-mm-dd in the month is <= this
  const rows = new Map();
  for (const c of customers) rows.set(c.id, emptyRow(c));

  for (const [date, day] of Object.entries(days)) {
    if (date > end) continue;
    const entries = (day && day.entries) || {};
    for (const [cid, entry] of Object.entries(entries)) {
      const row = rows.get(cid);
      if (!row) continue; // deleted customer
      const ch = entryCharge(entry, row.customer, settings);
      if (date < start) {
        row.previousDuePaise += ch.totalPaise;
      } else {
        row.milkMl += ch.milkMl;
        row.milkPaise += ch.milkPaise;
        row.paneerG += ch.paneerG;
        row.paneerPaise += ch.paneerPaise;
        if (ch.milkMl > 0) row.milkRates.add(ch.milkRatePaise);
        row.daily[date] = { milkMl: ch.milkMl, paneerG: ch.paneerG, skip: !!entry.skip, totalPaise: ch.totalPaise };
        if (ch.totalPaise > 0) row.hasActivity = true;
      }
    }
  }

  for (const p of payments) {
    const row = rows.get(p.customerId);
    if (!row || !p.date || p.date > end) continue;
    const amt = Math.round(p.amountPaise || 0);
    if (p.date < start) row.previousDuePaise -= amt;
    else {
      row.paidPaise += amt;
      row.payments.push(p);
      row.hasActivity = true;
    }
  }

  let billed = 0, collected = 0, pending = 0, advance = 0;
  let sBilled = 0, sPaid = 0, sPending = 0, sAdvance = 0;
  const list = [];
  for (const row of rows.values()) {
    row.billedPaise = row.milkPaise + row.paneerPaise;
    row.balancePaise = row.previousDuePaise + row.billedPaise - row.paidPaise;
    row.payments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (row.customer && row.customer.isSupplier) {
      sBilled += row.billedPaise;
      sPaid += row.paidPaise;
      if (row.balancePaise > 0) sPending += row.balancePaise;
      else sAdvance += -row.balancePaise;
    } else {
      billed += row.billedPaise;
      collected += row.paidPaise;
      if (row.balancePaise > 0) pending += row.balancePaise;
      else advance += -row.balancePaise;
    }
    list.push(row);
  }
  return {
    rows: list,
    totals: { billedPaise: billed, collectedPaise: collected, pendingPaise: pending, advancePaise: advance },
    supplierTotals: { billedPaise: sBilled, collectedPaise: sPaid, pendingPaise: sPending, advancePaise: sAdvance },
  };
}

/** Sort rows by highest balance due first, then by name. */
export function sortByDue(rows) {
  return [...rows].sort((a, b) => b.balancePaise - a.balancePaise || String(a.customer.name || '').localeCompare(String(b.customer.name || '')));
}

/** Payment helper: "full" pays the whole positive balance. */
export function fullPaymentPaise(balancePaise) {
  return balancePaise > 0 ? balancePaise : 0;
}
