// Keep a list's scroll position while a sub-screen (edit form, detail, bill sender...) replaces it.
// The page scrolls the window. The position is recorded continuously while the list is shown
// (a layout-effect listener, removed before the sub-screen's layout can clamp scrollY), the
// sub-screen opens at the top, and closing it puts the list back exactly where it was.
import { useLayoutEffect, useRef } from 'react';

// `key` (optional): the list being kept, e.g. the tab. If it changed while the sub-screen was
// open (another tab tapped), the new list starts at the top instead.
export function useScrollKeep(open, key = '') {
  const y = useRef(0);
  const wasOpen = useRef(false);
  const openKey = useRef(key);
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (open) {
      wasOpen.current = true;
      openKey.current = key;
      window.scrollTo(0, 0);
      return undefined;
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      const target = openKey.current === key ? y.current : 0;
      window.scrollTo(0, target);
      // Late layout (fonts, images) can shorten the page for a frame; try once more.
      if (window.requestAnimationFrame) window.requestAnimationFrame(() => window.scrollTo(0, target));
    }
    const on = () => {
      y.current = window.scrollY || window.pageYOffset || 0;
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}
