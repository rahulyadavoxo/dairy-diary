import { fmtQty, monthName, rupees, waNumber } from './format.js';
import { billBalance } from './billing.js';

/** Bilingual (Hindi + English) WhatsApp bill text for one customer's month row from computeMonth(). */
export function billText(row, month, settings = {}) {
  const c = row.customer;
  const farm = settings.farmName || 'Dairy Diary';
  const L = [];
  L.push(`*${farm}*`);
  L.push(`${c.name} — ${monthName(month, 'hi')} का बिल / Bill for ${monthName(month, 'en')}`);
  L.push('');
  const rates = [...(row.milkRates || [])];
  const rateTxt = rates.length === 1 ? ` × ${rupees(rates[0])}` : '';
  L.push(`दूध / Milk: ${fmtQty(row.milkMl / 1000)} L${rateTxt} = ${rupees(row.milkPaise)}`);
  if (row.paneerG > 0 || row.paneerPaise > 0) {
    L.push(`पनीर / Paneer: ${fmtQty(row.paneerG / 1000)} kg = ${rupees(row.paneerPaise)}`);
  }
  L.push(`इस महीने का बिल / This month: ${rupees(row.billedPaise)}`);
  if (row.previousDuePaise > 0) L.push(`पिछला बाकी / Previous due: ${rupees(row.previousDuePaise)}`);
  if (row.previousDuePaise < 0) L.push(`पिछला एडवांस / Previous advance: ${rupees(-row.previousDuePaise)}`);
  if (row.paidPaise !== 0) L.push(`जमा / Paid: ${rupees(row.paidPaise)}`);
  if ((row.paidAfterPaise || 0) > 0) L.push(`बाद में जमा / Paid later: ${rupees(row.paidAfterPaise)}`);
  L.push('');
  const bal = billBalance(row); // paid later beyond the due -> shown as advance
  if (bal >= 0) L.push(`*कुल बाकी / Balance due: ${rupees(bal)}*`);
  else L.push(`*एडवांस / Advance: ${rupees(-bal)}*`);
  L.push('');
  L.push(`धन्यवाद / Thank you 🙏${settings.phone ? `\n${farm}: ${settings.phone}` : ''}`);
  return L.join('\n');
}

export function waLink(phone, text) {
  const n = waNumber(phone);
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}
