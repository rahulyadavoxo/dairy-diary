// Small inline SVG icons (no image files, crisp at any size).
export function WhatsAppIcon({ size = 26 }) {
  return (
    <svg className="icon-wa" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <path
        fill="#25D366"
        d="M16 2.7C8.7 2.7 2.8 8.6 2.8 15.9c0 2.3.6 4.6 1.8 6.6L2.7 29.3l7-1.8c1.9 1 4.1 1.6 6.3 1.6 7.3 0 13.2-5.9 13.2-13.2S23.3 2.7 16 2.7z"
      />
      <path
        fill="#fff"
        d="M12.1 9.6c-.3-.6-.6-.6-.9-.6h-.8c-.3 0-.7.1-1.1.5-.4.4-1.4 1.4-1.4 3.4s1.5 3.9 1.7 4.2c.2.3 2.8 4.5 6.9 6.1 3.4 1.3 4.1 1.1 4.9 1 .7-.1 2.4-1 2.7-1.9.3-.9.3-1.7.2-1.9-.1-.2-.4-.3-.8-.5s-2.4-1.2-2.7-1.3c-.4-.1-.6-.2-.9.2-.3.4-1 1.3-1.3 1.6-.2.3-.5.3-.9.1-.4-.2-1.7-.6-3.2-2-1.2-1.1-2-2.4-2.2-2.8-.2-.4 0-.6.2-.8l.6-.7c.2-.2.3-.4.4-.7.1-.3.1-.5 0-.7l-1.4-3.2z"
      />
    </svg>
  );
}

export function BillIcon({ size = 22 }) {
  return (
    <svg className="icon-bill" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        d="M5 2.5h14v19l-2.3-1.5-2.4 1.5-2.3-1.5-2.3 1.5-2.4-1.5L5 21.5z"
        fill="#fff8e1"
        stroke="#1f6f43"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M8 7h8M8 10.5h8M8 14h5" stroke="#1f6f43" strokeWidth="1.6" strokeLinecap="round" />
      <text x="16.2" y="17.2" fontSize="5.5" fontWeight="700" fill="#1f6f43" textAnchor="middle">₹</text>
    </svg>
  );
}
