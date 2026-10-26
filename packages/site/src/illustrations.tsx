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
      <rect x="0" y="0" width="320" height="240" rx="24" fill="#eaf0fb" />
      <path
        d="M226 34c-20 22-46 30-58 52-10 18 4 34-8 52-14 22-56 26-74 58"
        stroke="#1f4fd1"
        strokeWidth="4"
        strokeDasharray="10 9"
        strokeLinecap="round"
      />
      <circle cx="226" cy="34" r="10" fill="#0b2353" />
      <circle cx="160" cy="138" r="6" fill="#f5b31c" />
      <circle cx="86" cy="196" r="10" fill="#f5b31c" stroke="#0b2353" strokeWidth="4" />
      <text
        x="244"
        y="40"
        fill="#0b2353"
        fontFamily="system-ui, sans-serif"
        fontSize="16"
        fontWeight="700"
      >
        Paris
      </text>
      <text
        x="104"
        y="216"
        fill="#0b2353"
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
      <rect x="0" y="0" width="320" height="200" rx="24" fill="#eef3fb" />
      <path d="M24 156h272" stroke="#c9d4e8" strokeWidth="4" strokeLinecap="round" />
      <rect x="40" y="62" width="236" height="80" rx="16" fill="#0b2353" />
      <rect x="52" y="74" width="168" height="30" rx="6" fill="#eaf0fb" />
      <path d="M232 74h28a8 8 0 0 1 8 8v22h-36V74Z" fill="#eaf0fb" />
      <path d="M40 116h236" stroke="#f5b31c" strokeWidth="6" />
      <circle cx="92" cy="146" r="16" fill="#0e1a33" stroke="#ffffff" strokeWidth="5" />
      <circle cx="226" cy="146" r="16" fill="#0e1a33" stroke="#ffffff" strokeWidth="5" />
    </svg>
  );
}

/** Shared parts of the PUBLIC-HOME-1 drawings, in the coach drawing's palette. */
function Box({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx="5"
        fill="#ffd98a"
        stroke="#0b2353"
        strokeWidth="3"
      />
      <path
        d={`M${x + w / 2 - 6} ${y}v${h}M${x + w / 2 + 6} ${y}v${h}`}
        stroke="#d99a0b"
        strokeWidth="3"
      />
      <rect
        x={x + 8}
        y={y + h - 20}
        width={Math.min(26, w / 2 - 12)}
        height="12"
        rx="2"
        fill="#ffffff"
      />
    </g>
  );
}

function Pallet({ x, y, w }: { x: number; y: number; w: number }) {
  return (
    <g fill="#0b2353">
      <rect x={x} y={y} width={w} height="6" rx="2" />
      <rect x={x} y={y + 12} width={w} height="6" rx="2" />
      <rect x={x + 6} y={y + 4} width="10" height="10" />
      <rect x={x + w / 2 - 5} y={y + 4} width="10" height="10" />
      <rect x={x + w - 16} y={y + 4} width="10" height="10" />
    </g>
  );
}

/** Original drawing of labelled parcels ready to be handed over. */
export function ParcelIllustration() {
  return (
    <svg
      className="public-illustration"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 320 200"
      fill="none"
    >
      <rect x="0" y="0" width="320" height="200" rx="24" fill="#eef3fb" />
      <path d="M24 164h272" stroke="#c9d4e8" strokeWidth="4" strokeLinecap="round" />
      <Box x={70} y={96} w={92} h={66} />
      <Box x={170} y={110} w={78} h={52} />
      <Box x={104} y={44} w={70} h={52} />
      <path
        d="M210 64c18-14 40-16 58-6"
        stroke="#1f4fd1"
        strokeWidth="4"
        strokeDasharray="8 8"
        strokeLinecap="round"
      />
      <circle cx="274" cy="62" r="9" fill="#f5b31c" stroke="#0b2353" strokeWidth="4" />
    </svg>
  );
}

/** Original drawing of a strapped freight load on its pallet. */
export function FreightIllustration() {
  return (
    <svg
      className="public-illustration"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 320 200"
      fill="none"
    >
      <rect x="0" y="0" width="320" height="200" rx="24" fill="#eaf0fb" />
      <path d="M24 170h272" stroke="#c9d4e8" strokeWidth="4" strokeLinecap="round" />
      <Pallet x={66} y={146} w={188} />
      <Box x={70} y={92} w={86} h={54} />
      <Box x={164} y={92} w={86} h={54} />
      <Box x={112} y={40} w={96} h={52} />
      <path d="M66 118h188M66 66h188" stroke="#1f4fd1" strokeWidth="4" strokeLinecap="round" />
      <path d="M66 66v80M254 66v80" stroke="#1f4fd1" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

/** Original composition of the three services: the coach, parcels and freight on one route. */
export function ServicesIllustration() {
  return (
    <svg
      className="public-illustration"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 360 240"
      fill="none"
    >
      <rect x="0" y="0" width="360" height="240" rx="26" fill="#eef3fb" />
      <path
        d="M40 70c50-44 120-50 170-26s90 20 112-6"
        stroke="#1f4fd1"
        strokeWidth="4"
        strokeDasharray="10 9"
        strokeLinecap="round"
      />
      <circle cx="40" cy="70" r="9" fill="#0b2353" />
      <circle cx="322" cy="38" r="10" fill="#f5b31c" stroke="#0b2353" strokeWidth="4" />
      <path d="M22 196h316" stroke="#c9d4e8" strokeWidth="4" strokeLinecap="round" />
      <rect x="28" y="108" width="176" height="64" rx="14" fill="#0b2353" />
      <rect x="38" y="118" width="124" height="24" rx="5" fill="#eaf0fb" />
      <path d="M170 118h20a6 6 0 0 1 6 6v18h-26v-24Z" fill="#eaf0fb" />
      <path d="M28 152h176" stroke="#f5b31c" strokeWidth="5" />
      <circle cx="68" cy="176" r="13" fill="#0e1a33" stroke="#ffffff" strokeWidth="4" />
      <circle cx="166" cy="176" r="13" fill="#0e1a33" stroke="#ffffff" strokeWidth="4" />
      <Box x={222} y={140} w={46} h={40} />
      <Box x={236} y={104} w={36} h={36} />
      <Pallet x={276} y={176} w={60} />
      <Box x={280} y={130} w={52} h={46} />
    </svg>
  );
}
