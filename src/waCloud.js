// WhatsApp Cloud API calls made from the owner's phone (connect check + test bill).
// Native: CapacitorHttp (no browser CORS). Web/tests: fetch.
import { GRAPH_VERSION, TEMPLATE_DEFAULT, templateMessage, templateParams } from './autoBill.js';
import { addMonths, todayISO } from './format.js';

async function http(method, url, token, body) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let status, data;
  try {
    const { Capacitor, CapacitorHttp } = await import('@capacitor/core');
    if (Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) {
      const r = await CapacitorHttp.request({ method, url, headers, data: body });
      status = r.status;
      data = typeof r.data === 'string' ? JSON.parse(r.data || '{}') : r.data;
    }
  } catch (e) {
    if (status) throw e;
  }
  if (!status) {
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    status = r.status;
    data = await r.json().catch(() => ({}));
  }
  if (status < 200 || status >= 300) {
    const e = (data && data.error) || {};
    throw new Error(`WhatsApp: ${e.code || status}: ${e.message || 'error'}`.slice(0, 220));
  }
  return data || {};
}

const G = `https://graph.facebook.com/${GRAPH_VERSION}`;
const privPath = (fb) => ['farms', fb.farmId, 'waPrivate', 'main'];

/** Check the ids with Meta, then save them (owner only — firestore.rules). Returns display text. */
export async function waConnect(fb, { phoneNumberId, accessToken, templateName, templateLang }) {
  const pnid = String(phoneNumberId || '').trim();
  const token = String(accessToken || '').trim();
  if (!/^\d{6,30}$/.test(pnid)) throw new Error('Phone number ID: only digits');
  if (token.length < 20) throw new Error('Access token missing');
  const info = await http('GET', `${G}/${pnid}?fields=display_phone_number,verified_name`, token);
  const display = `${info.verified_name || ''} ${info.display_phone_number || ''}`.trim().slice(0, 80);
  const template = { name: String(templateName || '').trim() || TEMPLATE_DEFAULT.name, lang: String(templateLang || '').trim() || TEMPLATE_DEFAULT.lang };
  const { doc, setDoc } = fb.fsMod;
  await setDoc(doc(fb.db, ...privPath(fb)), { phoneNumberId: pnid, accessToken: token, template, display, connectedAt: Date.now() });
  await setDoc(doc(fb.db, 'farms', fb.farmId, 'settings', 'main'), { autoBill: { connected: true, display } }, { merge: true });
  return { display };
}

export async function waDisconnect(fb) {
  const { doc, setDoc, deleteDoc } = fb.fsMod;
  await deleteDoc(doc(fb.db, ...privPath(fb)));
  await setDoc(doc(fb.db, 'farms', fb.farmId, 'settings', 'main'), { autoBill: { connected: false, display: '' } }, { merge: true });
}

/** Sample bill (₹1,234) to a typed number, with the saved ids (owner's phone). */
export async function waTest(fb, phone, settings = {}) {
  const { doc, getDoc } = fb.fsMod;
  const snap = await getDoc(doc(fb.db, ...privPath(fb)));
  const p = snap && snap.exists() ? snap.data() : null;
  if (!p) throw new Error('WhatsApp not connected');
  const month = addMonths(todayISO().slice(0, 7), -1);
  const row = { customer: { name: 'Test' }, billedPaise: 123400, balancePaise: 123400 };
  return http('POST', `${G}/${p.phoneNumberId}/messages`, p.accessToken, templateMessage(phone, templateParams(row, month, settings), p.template));
}

export const WA_API = { connect: waConnect, disconnect: waDisconnect, test: waTest };
