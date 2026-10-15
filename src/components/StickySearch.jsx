// Search box that stays pinned at the top of the screen while the list scrolls
// (Register, Hisaab, Customers - user, 15 Oct 2026). CSS position: sticky does the pinning;
// the "stuck" class (set while it is pinned) paints the status-bar strip above it and a shadow.
import { useEffect, useRef, useState } from 'react';

export default function StickySearch({ children }) {
  const ref = useRef(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return undefined;
    const check = () => {
      const top = parseFloat(getComputedStyle(el).top) || 0;
      // pinned = its box sits at the sticky offset and the page has scrolled
      const now = (window.scrollY || 0) > 0 && el.getBoundingClientRect().top <= top + 1;
      setStuck((s) => (s === now ? s : now));
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, []);
  return (
    <div ref={ref} className={'search-sticky' + (stuck ? ' stuck' : '')} data-testid="search-sticky">
      {children}
    </div>
  );
}
