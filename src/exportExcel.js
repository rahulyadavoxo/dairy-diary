// Month register + hisaab as a CSV file that Excel / Google Sheets open directly (v1.10.42).
// One file per month: a day-by-day milk grid with the month's bill for every customer,
// the suppliers below it, then every payment of the month. Amounts are plain rupee numbers
// (no ₹ sign) so Excel can add them up. UTF-8 with BOM so Hindi names show correctly.
import { Capacitor } from '@capacitor/core';
import { computeMonth } from './billing.js';
import { monthDates, monthName } from './format.js';
import { blobToBase64, WhatsAppShare as FileShare } from './waShare.js';

const H = {
  hi: {
    name: 'नाम', phone: 'फ़ोन', milkL: 'कुल दूध (L)', paneerG: 'पनीर (g)', milkRs: 'दूध ₹', paneerRs: 'पनीर ₹',
    billRs: 'इस महीने का बिल ₹', prevRs: 'पिछला बाकी ₹', paidRs: 'मिला ₹', balRs: 'कुल बाकी ₹',
    total: 'कुल', customers: 'ग्राहक', suppliers: 'सप्लायर (जिनसे दूध लेते हैं)', payments: 'भुगतान',
    date: 'तारीख', amount: 'रकम ₹', mode: 'तरीका', note: 'नोट', absent: 'नहीं',
  },
  en: {
    name: 'Name', phone: 'Phone', milkL: 'Total milk (L)', paneerG: 'Paneer (g)', milkRs: 'Milk ₹', paneerRs: 'Paneer ₹',
    billRs: 'Bill this month ₹', prevRs: 'Previous due ₹', paidRs: 'Paid ₹', balRs: 'Balance ₹',
    total: 'Total', customers: 'Customers', suppliers: 'Suppliers (we buy milk from them)', payments: 'Payments',
    date: 'Date', amount: 'Amount ₹', mode: 'Mode', note: 'Note', absent: 'No',
  },
};

const rs = (paise) => (Math.round(paise || 0) / 100).toFixed(2);
const litres = (ml) => (ml ? String(Math.round(ml) / 1000) : '');

function cell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const line = (arr) => arr.map(cell).join(',');

/** CSV text (without BOM) for one month. */
export function monthCsv({ customers = [], days = {}, payments = [], settings = {}, month, lang = 'hi' }) {
  const h = H[lang] || H.en;
  const dates = monthDates(month);
  const res = computeMonth({ customers, days, payments, settings, month });
  const rows = res.rows
    .filter((r) => r.customer.active !== false || r.hasActivity || r.balancePaise !== 0)
    .sort((a, b) => (a.customer.order ?? 1e9) - (b.customer.order ?? 1e9) || String(a.customer.name).localeCompare(String(b.customer.name)));

  const head = ['#', h.name, h.phone, ...dates.map((d) => String(Number(d.slice(8)))), h.milkL, h.paneerG, h.milkRs, h.paneerRs, h.billRs, h.prevRs, h.paidRs, h.balRs];
  const out = [line([settings.farmName || 'Dairy Diary', monthName(month, lang)]), ''];

  const block = (title, list) => {
    out.push(line([title]));
    out.push(line(head));
    const sum = { milkMl: 0, paneerG: 0, milkPaise: 0, paneerPaise: 0, billedPaise: 0, previousDuePaise: 0, paidPaise: 0, balancePaise: 0 };
    const perDay = dates.map(() => 0);
    list.forEach((r, i) => {
      const cells = dates.map((d, k) => {
        const x = r.daily[d];
        if (!x) return '';
        perDay[k] += x.milkMl || 0;
        if (x.skip && !x.milkMl && !x.paneerG) return h.absent;
        let v = litres(x.milkMl);
        if (x.paneerG) v = (v ? v + ' + ' : '') + x.paneerG + 'g';
        return v || '0';
      });
      for (const k of Object.keys(sum)) sum[k] += r[k] || 0;
      out.push(line([i + 1, r.customer.name, r.customer.phone || '', ...cells, litres(r.milkMl) || '0', r.paneerG || 0, rs(r.milkPaise), rs(r.paneerPaise), rs(r.billedPaise), rs(r.previousDuePaise), rs(r.paidPaise), rs(r.balancePaise)]));
    });
    out.push(line(['', h.total, '', ...perDay.map((ml) => litres(ml)), litres(sum.milkMl) || '0', sum.paneerG, rs(sum.milkPaise), rs(sum.paneerPaise), rs(sum.billedPaise), rs(sum.previousDuePaise), rs(sum.paidPaise), rs(sum.balancePaise)]));
    out.push('');
  };

  block(h.customers, rows.filter((r) => !r.customer.isSupplier));
  const sup = rows.filter((r) => r.customer.isSupplier);
  if (sup.length) block(h.suppliers, sup);

  const names = new Map(customers.map((c) => [c.id, c.name]));
  const pays = payments
    .filter((p) => p.date && p.date.slice(0, 7) === month)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  out.push(line([h.payments]));
  out.push(line([h.date, h.name, h.amount, h.mode, h.note]));
  pays.forEach((p) => out.push(line([p.date, names.get(p.customerId) || '', rs(p.amountPaise), p.mode || '', p.note || ''])));
  out.push(line([h.total, '', rs(pays.reduce((s, p) => s + Math.round(p.amountPaise || 0), 0))]));
  return out.join('\r\n') + '\r\n';
}

export function exportFileName(settings, month) {
  const farm = String((settings && settings.farmName) || 'dairy-diary').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 30) || 'dairy-diary';
  return `${farm}-${month}.csv`;
}

/** Build the month file and open the share sheet (WhatsApp, Drive, Gmail, Files...). */
export async function shareMonthExcel(args) {
  const text = '\ufeff' + monthCsv(args);
  const fileName = exportFileName(args.settings, args.month);
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  if (Capacitor.isNativePlatform()) {
    const base64 = await blobToBase64(blob);
    await FileShare.shareFile({ base64, fileName, mimeType: 'text/csv' });
    return 'shared';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
