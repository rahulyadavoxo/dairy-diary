// Swipe left / right on the main screen to move between the bottom tabs
// (Register <-> Hisaab <-> Customers <-> Settings; user, 15 Oct 2026).
export const TAB_ORDER = ['register', 'hisaab', 'customers', 'settings'];
export const MIN_DX = 70; // px of sideways travel
export const MAX_MS = 700; // a quick flick, not a slow drag

// Where a swipe must NOT change tab: typing, popups, and strips that scroll sideways themselves.
const BLOCK = 'input, textarea, select, .modal-backdrop, .full-overlay, .paid-overlay, [data-noswipe]';

export function blockedTarget(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.matches && n.matches(BLOCK)) return true;
    if (n.scrollWidth > n.clientWidth + 1) {
      const ox = typeof getComputedStyle === 'function' ? getComputedStyle(n).overflowX : '';
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

// Returns the tab to go to, or null.
export function swipeTarget(tab, start, end) {
  if (!start || !end) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (end.t - start.t > MAX_MS) return null;
  if (Math.abs(dx) < MIN_DX || Math.abs(dx) < 2 * Math.abs(dy)) return null;
  const i = TAB_ORDER.indexOf(tab);
  if (i < 0) return null;
  const j = dx < 0 ? i + 1 : i - 1; // finger moves left -> next tab
  return j >= 0 && j < TAB_ORDER.length ? TAB_ORDER[j] : null;
}
