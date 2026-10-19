import type { ReactElement } from 'react';
import type { CONTENT_ICONS } from '@euroteranga/content';

/** Icons of the on-board equipment (UI-PUBLIC-2), not offered to editors. */
export type AmenityIconName =
  | 'snowflake'
  | 'recline'
  | 'plug'
  | 'wifi'
  | 'toilet'
  | 'screen'
  | 'wheelchair'
  | 'users'
  | 'check';

export type IconName = (typeof CONTENT_ICONS)[number] | AmenityIconName | 'arrow' | 'menu';

const stroke = { stroke: 'currentColor', strokeWidth: 2, fill: 'none' } as const;

const PATHS: Record<IconName, ReactElement> = {
  menu: <path d="M4 7h16M4 12h16M4 17h16" {...stroke} strokeLinecap="round" />,
  arrow: (
    <path d="M5 12h14M14 7l5 5-5 5" {...stroke} strokeLinecap="round" strokeLinejoin="round" />
  ),
  pin: (
    <>
      <path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z" {...stroke} />
      <circle cx="12" cy="10" r="2.2" fill="currentColor" />
    </>
  ),
  ticket: (
    <>
      <path
        d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V9a3 3 0 0 0 0 6v1.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V15a3 3 0 0 0 0-6V7.5Z"
        {...stroke}
      />
      <path d="M12 8v8" {...stroke} strokeDasharray="2 2" />
    </>
  ),
  luggage: (
    <>
      <path
        d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7M6.5 7h11A1.5 1.5 0 0 1 19 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 17.5v-9A1.5 1.5 0 0 1 6.5 7Z"
        {...stroke}
      />
      <path d="M9 10v6M15 10v6" {...stroke} strokeLinecap="round" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 19 6v5c0 4.8-2.9 8.1-7 10-4.1-1.9-7-5.2-7-10V6l7-3Z" {...stroke} />
      <path d="m9 12 2 2 4-4" {...stroke} strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  bus: (
    <>
      <rect x="4" y="4" width="16" height="13" rx="3" {...stroke} />
      <path d="M4 12h16M8 20v-3M16 20v-3" {...stroke} strokeLinecap="round" />
      <circle cx="8" cy="14.5" r="1" fill="currentColor" />
      <circle cx="16" cy="14.5" r="1" fill="currentColor" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" {...stroke} />
      <path d="M12 8v4l3 2" {...stroke} strokeLinecap="round" />
    </>
  ),
  support: (
    <>
      <path d="M5 13v-1a7 7 0 0 1 14 0v1" {...stroke} />
      <rect x="4" y="13" width="4" height="6" rx="1.5" {...stroke} />
      <rect x="16" y="13" width="4" height="6" rx="1.5" {...stroke} />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="18" r="2" {...stroke} />
      <circle cx="18" cy="6" r="2" {...stroke} />
      <path d="M8 18h5a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h5" {...stroke} strokeLinecap="round" />
    </>
  ),
  seat: (
    <>
      <path d="M7 4h7a2 2 0 0 1 2 2v7H9a2 2 0 0 1-2-2V4Z" {...stroke} />
      <path d="M5 13h12a2 2 0 0 1 2 2v1H5v-3ZM7 16v4M17 16v4" {...stroke} strokeLinecap="round" />
    </>
  ),
  phone: (
    <path
      d="M6.5 4h3l1.5 4-2 1.5a10 10 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A15 15 0 0 1 4.5 6a2 2 0 0 1 2-2Z"
      {...stroke}
      strokeLinejoin="round"
    />
  ),
  mail: (
    <>
      <rect x="4" y="6" width="16" height="12" rx="2" {...stroke} />
      <path d="m5 8 7 5 7-5" {...stroke} strokeLinejoin="round" />
    </>
  ),
  snowflake: (
    <path
      d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5"
      {...stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  recline: (
    <>
      <path d="M6 4l3 9h7a2 2 0 0 1 2 2v1H8.5" {...stroke} strokeLinejoin="round" />
      <path d="M8 16l-1 4M17 16v4M12 8h4" {...stroke} strokeLinecap="round" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0V7Z" {...stroke} strokeLinejoin="round" />
      <path d="M12 16v5" {...stroke} strokeLinecap="round" />
    </>
  ),
  wifi: (
    <>
      <path
        d="M3.5 9.5a12 12 0 0 1 17 0M6.5 12.5a8 8 0 0 1 11 0M9.5 15.5a4 4 0 0 1 5 0"
        {...stroke}
        strokeLinecap="round"
      />
      <circle cx="12" cy="18.5" r="1.3" fill="currentColor" />
    </>
  ),
  toilet: (
    <>
      <path d="M6 4h5v8H6zM4 12h15a6 6 0 0 1-6 6h-3a6 6 0 0 1-6-6Z" {...stroke} />
      <path d="M9 18l-1 3h8l-1-3" {...stroke} strokeLinejoin="round" />
    </>
  ),
  screen: (
    <>
      <rect x="3.5" y="5" width="17" height="11" rx="2" {...stroke} />
      <path d="M9 20h6M12 16v4" {...stroke} strokeLinecap="round" />
      <path d="m10.5 8.5 3.5 2-3.5 2v-4Z" fill="currentColor" />
    </>
  ),
  wheelchair: (
    <>
      <circle cx="11" cy="4.5" r="1.5" fill="currentColor" />
      <path d="M11 7v6h5l2 5M11 10h4" {...stroke} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 11.5a5 5 0 1 0 6.5 6.5" {...stroke} strokeLinecap="round" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3" {...stroke} />
      <path
        d="M3.5 19a5.5 5.5 0 0 1 11 0M15 5.5a3 3 0 0 1 0 5M17 14a5 5 0 0 1 3.5 5"
        {...stroke}
        strokeLinecap="round"
      />
    </>
  ),
  check: (
    <path d="m5 12.5 4.5 4.5L19 7.5" {...stroke} strokeLinecap="round" strokeLinejoin="round" />
  ),
};

/** Decorative icon: always aria-hidden, the text next to it carries the meaning. */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

/** The EURO TERANGA coach mark of the header and footer. */
export function CoachMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 22" fill="none" focusable="false">
      <rect x="3" y="3" width="26" height="14" rx="4" stroke="currentColor" strokeWidth="2" />
      <path d="M7 7h18v5H7V7Z" fill="currentColor" opacity=".18" />
      <circle cx="9" cy="18" r="2" fill="currentColor" />
      <circle cx="23" cy="18" r="2" fill="currentColor" />
      <path d="M3 13h26" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
