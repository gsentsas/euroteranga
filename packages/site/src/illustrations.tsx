import { CoachMark } from './icons.js';

/** Decorative tracking visual: a route between two pins with a coach (pure CSS shapes). */
export function TrackingIllustration() {
  return (
    <div className="public-tracking__visual" aria-hidden="true">
      <span className="public-tracking__path" />
      <span className="public-tracking__pin public-tracking__pin--start" />
      <span className="public-tracking__pin public-tracking__pin--end" />
      <span className="public-tracking__bus">
        <CoachMark />
      </span>
    </div>
  );
}

/** Original line drawing of the corridor: Paris, the Strait of Gibraltar, Dakar. */
export function RouteIllustration() {
  return (
    <svg
      className="public-illustration"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 320 240"
      fill="none"
    >
      <rect x="0" y="0" width="320" height="240" rx="24" fill="#e8f5ef" />
      <path
        d="M226 34c-20 22-46 30-58 52-10 18 4 34-8 52-14 22-56 26-74 58"
        stroke="#0b5d4b"
        strokeWidth="4"
        strokeDasharray="10 9"
        strokeLinecap="round"
      />
      <circle cx="226" cy="34" r="10" fill="#073b31" />
      <circle cx="160" cy="138" r="6" fill="#e7aa2f" />
      <circle cx="86" cy="196" r="10" fill="#e7aa2f" stroke="#073b31" strokeWidth="4" />
      <text
        x="244"
        y="40"
        fill="#073b31"
        fontFamily="system-ui, sans-serif"
        fontSize="16"
        fontWeight="700"
      >
        Paris
      </text>
      <text
        x="104"
        y="216"
        fill="#073b31"
        fontFamily="system-ui, sans-serif"
        fontSize="16"
        fontWeight="700"
      >
        Dakar
      </text>
    </svg>
  );
}

/** Original side view of a long-distance coach. */
export function CoachIllustration() {
  return (
    <svg
      className="public-illustration"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 320 200"
      fill="none"
    >
      <rect x="0" y="0" width="320" height="200" rx="24" fill="#f8f1df" />
      <path d="M24 156h272" stroke="#d9cfb5" strokeWidth="4" strokeLinecap="round" />
      <rect x="40" y="62" width="236" height="80" rx="16" fill="#073b31" />
      <rect x="52" y="74" width="168" height="30" rx="6" fill="#e8f5ef" />
      <path d="M232 74h28a8 8 0 0 1 8 8v22h-36V74Z" fill="#e8f5ef" />
      <path d="M40 116h236" stroke="#e7aa2f" strokeWidth="6" />
      <circle cx="92" cy="146" r="16" fill="#17201d" stroke="#fffdf7" strokeWidth="5" />
      <circle cx="226" cy="146" r="16" fill="#17201d" stroke="#fffdf7" strokeWidth="5" />
    </svg>
  );
}
