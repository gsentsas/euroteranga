import type { ReactElement } from 'react';
import type { CONTENT_ICONS } from '@euroteranga/content';

export type IconName = (typeof CONTENT_ICONS)[number] | 'arrow' | 'menu';

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
