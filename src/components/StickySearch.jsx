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
      <div className="search-box">
        {children}
        {/* magnifier on the right (user, 15 Oct); hidden once text is typed so the clear ✕ has room */}
        <svg className="search-icon-r" data-testid="search-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
          <path d="M15.5 15.5 L21 21" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
