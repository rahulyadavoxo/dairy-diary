// List edge animation (cards shrink/fade at the top and bottom while scrolling).
// Phone-local switch in Settings; on by default. Adds/removes the html.list-anim class.
const KEY = 'dd_list_anim';

export function listAnimOn() {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function applyListAnim(on = listAnimOn()) {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('list-anim', !!on);
}

export function setListAnim(on) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* private mode */
  }
  applyListAnim(on);
}
