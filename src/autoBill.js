// WhatsApp auto-bill (Nov 2026): pure helpers shared by the app and the Cloud Functions
// (functions/ gets a copy of this file, billing.js and format.js at deploy time).
import { monthName, rupees, waNumber, addMonths } from './format.js';

export const AUTO_BILL_DEFAULT = { enabled: false, day: 1, time: '09:00' };
export const TEMPLATE_DEFAULT = { name: 'dd_bill', lang: 'hi' };
export const GRAPH_VERSION = 'v23.0';

/** Same people BillSender sends to: phone saved, not a supplier, something to say. */
export const autoBillTarget = (r) =>
  !!(r && r.customer && r.customer.phone) &&
  !r.customer.isSupplier &&
  r.customer.waAutoBill !== false &&
  (r.balancePaise !== 0 || r.hasActivity) &&
  waNumber(r.customer.phone).length >= 11;

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
    balanceText(row.leftPaise !== undefined ? row.leftPaise : row.balancePaise),
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
