import { Capacitor, registerPlugin } from '@capacitor/core';
import { waNumber } from './format.js';
import { shareImage } from './billImage.js';

export const WhatsAppShare = registerPlugin('WhatsAppShare');

/** Normalised WhatsApp number (country code + digits), or null when missing or invalid. */
export function validWaNumber(phone) {
  const n = waNumber(phone);
  if (!n) return null;
  if (n.startsWith('91') && n.length === 12) return /^91[6-9]\d{9}$/.test(n) ? n : null;
  return /^[1-9]\d{10,14}$/.test(n) ? n : null;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

/** True when the user cancelled the share (not a real failure). */
export function isShareCancel(e) {
  if (!e) return false;
  if (e.name === 'AbortError') return true;
  if (e.code === 'SHARE_CANCELLED') return true;
  return /abort|cancel|dismiss/i.test(String((e && e.message) || e));
}

/**
 * Send ONLY the bill PNG to WhatsApp (no text).
 * phone: a validWaNumber() result opens that chat directly; null opens WhatsApp's contact picker.
 * Resolves 'direct' | 'picker' on Android, or shareImage()'s result on the web.
 * Rejects with err.code 'NOT_INSTALLED' | 'SHARE_FAILED' | 'NO_IMAGE'.
 */
export async function sendBillToWhatsApp({ blob, fileName, phone }) {
  if (Capacitor.isNativePlatform()) {
    const base64 = await blobToBase64(blob);
    await WhatsAppShare.shareImage({ base64, fileName, phone: phone || undefined });
    return phone ? 'direct' : 'picker';
  }
  return shareImage(blob, fileName);
}

/**
 * Open the customer's WhatsApp chat (no text, no photo). WhatsApp only honours the direct-chat
 * "jid" on a photo share when a chat with that number already exists, so for a new customer the
 * photo share lands on "Send to…". Opening the chat once (and sending any message) fixes it.
 */
export async function openWhatsAppChat(phone) {
  if (!phone) return;
  if (Capacitor.isNativePlatform()) return WhatsAppShare.openChat({ phone });
  window.open(`https://wa.me/${phone}`, '_blank', 'noopener');
}
