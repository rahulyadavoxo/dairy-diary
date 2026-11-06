// WhatsApp auto-bill (Nov 2026): pure helpers shared by the app and the Cloud Functions
// (functions/ gets a copy of this file, billing.js and format.js at deploy time).
import { monthName, rupees, waNumber, addMonths, addDays } from './format.js';
import { billBalance } from './billing.js';

export const AUTO_BILL_DEFAULT = { enabled: false, day: 1, time: '09:00' };
export const TEMPLATE_DEFAULT = { name: 'dd_bill', lang: 'hi' };
export const GRAPH_VERSION = 'v23.0';

/** WhatsApp number check - the SAME rule as the manual sender (src/waShare.js validWaNumber):
 *  an Indian number must be 91 + 6-9 + 9 digits; any other must be 11-15 digits, no leading 0.
 *  (fix-bills #1: a number the app calls invalid used to go to Meta and come back as error 100.) */
export const okWaNumber = (n) =>
  !!n && (n.startsWith('91') && n.length === 12 ? /^91[6-9]\d{9}$/.test(n) : /^[1-9]\d{10,14}$/.test(n));

/** Same people BillSender sends to: phone saved, not a supplier, something to say. */
export const autoBillTarget = (r) =>
  !!(r && r.customer && r.customer.phone) &&
  !r.customer.isSupplier &&
  r.customer.waAutoBill !== false &&
  (r.balancePaise !== 0 || r.hasActivity) &&
  okWaNumber(waNumber(r.customer.phone));

/** India time parts for a Date (server runs in UTC). */
export function istParts(date = new Date()) {
  const ist = new Date(date.getTime() + 330 * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    month: `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}`,
    day: ist.getUTCDate(),
    hm: `${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}`,
    date: `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())}`,
  };
}

/** The bill month to send now, or null. Sends LAST month once the set day+time has come;
 *  `doneMonth` = last month already finished (never sends the same month twice). */
export function dueBillMonth(autoBill, now = new Date(), doneMonth = null) {
  if (!autoBill || !autoBill.enabled) return null;
  const day = Math.min(28, Math.max(1, Number(autoBill.day) || 1));
  const time = /^\d{2}:\d{2}$/.test(autoBill.time || '') ? autoBill.time : '09:00';
  const t = istParts(now);
  if (t.day < day || (t.day === day && t.hm < time)) return null;
  const billMonth = addMonths(t.month, -1);
  if (doneMonth && doneMonth >= billMonth) return null;
  return billMonth;
}

/** Auto-bill waits for the LAST DAY of the bill month (fix-bills #4), like the manual sender's
 *  "last day empty" warning: true = don't send yet. Rule: while that day has no entry (and the
 *  dairy has an active, non-supplier customer) the run waits, but only until the 3rd of the next
 *  month (IST). From the 3rd on the bills go out even if the day is still empty. */
export const LAST_DAY_GRACE_DAYS = 2;
export function lastDayWait(days, customers, month, now = new Date()) {
  const first = `${addMonths(month, 1)}-01`;
  const lastDay = addDays(first, -1);
  const d = days && days[lastDay];
  if (d && d.entries && Object.keys(d.entries).length > 0) return false;
  if (!(customers || []).some((c) => c && c.active !== false && !c.isSupplier)) return false;
  return istParts(now).date < addDays(first, LAST_DAY_GRACE_DAYS);
}

/** Balance line for the template: "₹1,250 बाकी" / "₹200 एडवांस" / "₹0 बाकी". */
export function balanceText(balancePaise) {
  return balancePaise < 0 ? `${rupees(-balancePaise)} एडवांस` : `${rupees(balancePaise)} बाकी`;
}

/** Body parameters for the Meta template (see notes/whatsapp-template.md):
 *  नमस्ते {{1}} जी, {{2}} का दूध का बिल {{3}} है। कुल हिसाब: {{4}}। धन्यवाद, {{5}} */
export function templateParams(row, month, settings = {}) {
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n) || '-';
  return [
    clip(row.customer.name, 60),
    monthName(month, 'hi'),
    rupees(row.billedPaise),
    balanceText(billBalance(row)),
    clip(settings.farmName || 'Dairy Diary', 60),
  ];
}

/** Graph API request body for one bill. */
export function templateMessage(phone, params, template = TEMPLATE_DEFAULT) {
  return {
    messaging_product: 'whatsapp',
    to: waNumber(phone),
    type: 'template',
    template: {
      name: template.name || TEMPLATE_DEFAULT.name,
      language: { code: template.lang || TEMPLATE_DEFAULT.lang },
      components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }],
    },
  };
}
