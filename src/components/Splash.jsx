// Start-up / loading screen: a milk bottle filling up with a moving wave, a drop falling in,
// and the app name. Pure SVG + CSS (no image files); still when the phone asks for reduced motion.
export const BOTTLE_PATH = 'M46 22h28v12c0 5 16 12 16 28v80a12 12 0 0 1-12 12H42a12 12 0 0 1-12-12V62c0-16 16-23 16-28z';

export default function Splash({ text, children }) {
  return (
    <div className="center-screen splash" role="status" aria-live="polite" data-testid="splash">
      <svg className="splash-bottle" viewBox="0 0 120 160" width="120" height="160" aria-hidden="true">
        <defs>
          <clipPath id="dd-bottle-clip">
            <path d={BOTTLE_PATH} />
          </clipPath>
        </defs>
        <circle className="splash-drop" cx="60" cy="4" r="4" />
        <g clipPath="url(#dd-bottle-clip)">
          <rect x="0" y="0" width="120" height="160" className="splash-glass" />
          <g className="splash-milk">
            <path
              className="splash-wave back"
              d="M-120 8 q15 -8 30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 V200 H-120 Z"
            />
            <path
              className="splash-wave"
              d="M-120 10 q15 -8 30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 V200 H-120 Z"
            />
          </g>
        </g>
        <path d={BOTTLE_PATH} className="splash-outline" />
        <rect x="43" y="14" width="34" height="10" rx="3" className="splash-cap" />
      </svg>
      <div className="splash-name">Dairy Diary</div>
      <div className="splash-text">
        {text}
      </div>
      {children}
    </div>
  );
}
