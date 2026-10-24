import type { SVGProps } from 'react';

export type OpsIconName =
  | 'alert'
  | 'audit'
  | 'baggage'
  | 'bell'
  | 'booking'
  | 'building'
  | 'bus'
  | 'cargo'
  | 'chart'
  | 'check'
  | 'chevron'
  | 'close'
  | 'content'
  | 'dashboard'
  | 'dispatch'
  | 'document'
  | 'finance'
  | 'location'
  | 'manifest'
  | 'media'
  | 'menu'
  | 'network'
  | 'payment'
  | 'permit'
  | 'pricing'
  | 'review'
  | 'roles'
  | 'route'
  | 'search'
  | 'seat'
  | 'shield'
  | 'users';

export function OpsIcon({ name, ...props }: { name: OpsIconName } & SVGProps<SVGSVGElement>) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };

  const glyph = (() => {
    switch (name) {
      case 'dashboard':
        return (
          <>
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="4" rx="1" />
            <rect x="14" y="11" width="7" height="10" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
          </>
        );
      case 'network':
        return (
          <>
            <circle cx="5" cy="12" r="2" />
            <circle cx="19" cy="5" r="2" />
            <circle cx="19" cy="19" r="2" />
            <path d="m7 11 10-5M7 13l10 5" />
          </>
        );
      case 'bus':
        return (
          <>
            <rect x="4" y="3" width="16" height="16" rx="3" />
            <path d="M7 19v2m10-2v2M4 11h16M7 7h10" />
            <circle cx="8" cy="15" r="1" />
            <circle cx="16" cy="15" r="1" />
          </>
        );
      case 'route':
        return (
          <>
            <circle cx="6" cy="18" r="2" />
            <circle cx="18" cy="6" r="2" />
            <path d="M8 18h2a3 3 0 0 0 3-3V9a3 3 0 0 1 3-3" />
          </>
        );
      case 'location':
        return (
          <>
            <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
            <circle cx="12" cy="10" r="2.5" />
          </>
        );
      case 'alert':
        return (
          <>
            <path d="m12 3 9 17H3L12 3Z" />
            <path d="M12 9v4m0 3h.01" />
          </>
        );
      case 'seat':
        return (
          <>
            <path d="M7 4v8a3 3 0 0 0 3 3h8" />
            <path d="M18 8v12M7 20v-5M5 4h4" />
            <path d="M10 9h6a2 2 0 0 1 2 2v4" />
          </>
        );
      case 'pricing':
        return (
          <>
            <path d="M20 13 13 20l-9-9V4h7l9 9Z" />
            <circle cx="8.5" cy="8.5" r="1" />
          </>
        );
      case 'booking':
        return (
          <>
            <rect x="4" y="5" width="16" height="16" rx="2" />
            <path d="M8 3v4m8-4v4M4 10h16m-11 4h6m-6 3h4" />
          </>
        );
      case 'payment':
        return (
          <>
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M3 10h18M7 15h3" />
          </>
        );
      case 'finance':
        return (
          <>
            <path d="M4 20V10m5 10V4m6 16v-7m5 7V7" />
          </>
        );
      case 'chart':
        return (
          <>
            <path d="M4 20V10m6 10V4m6 16v-7m4 7H2" />
          </>
        );
      case 'baggage':
        return (
          <>
            <rect x="5" y="7" width="14" height="13" rx="2" />
            <path d="M9 7V4h6v3M9 12v4m6-4v4M3 11v5m18-5v5" />
          </>
        );
      case 'cargo':
        return (
          <>
            <path d="m3 7 9-4 9 4-9 4-9-4Z" />
            <path d="m3 7 9 4 9-4v10l-9 4-9-4V7Z" />
            <path d="M12 11v10" />
          </>
        );
      case 'check':
        return (
          <>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="m8 12 3 3 6-7" />
          </>
        );
      case 'manifest':
        return (
          <>
            <path d="M6 3h9l3 3v15H6V3Z" />
            <path d="M14 3v4h4M9 11h6m-6 4h6m-6 4h4" />
          </>
        );
      case 'permit':
        return (
          <>
            <path d="M7 3h10v18l-5-3-5 3V3Z" />
            <path d="m9 10 2 2 4-5" />
          </>
        );
      case 'dispatch':
        return (
          <>
            <path d="M3 12h12m0 0-4-4m4 4-4 4" />
            <path d="M15 5h5v14h-5" />
          </>
        );
      case 'document':
        return (
          <>
            <path d="M6 3h8l4 4v14H6V3Z" />
            <path d="M14 3v5h4M9 12h6m-6 4h6" />
          </>
        );
      case 'shield':
        return (
          <>
            <path d="M12 3 20 6v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z" />
            <path d="m9 12 2 2 4-5" />
          </>
        );
      case 'review':
        return (
          <>
            <circle cx="10" cy="10" r="6" />
            <path d="m15 15 5 5M7.5 10l1.5 1.5 3.5-4" />
          </>
        );
      case 'content':
        return (
          <>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M7 8h10M7 12h7M7 16h5" />
          </>
        );
      case 'media':
        return (
          <>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="9" cy="10" r="2" />
            <path d="m4 18 5-5 3 3 2-2 6 6" />
          </>
        );
      case 'users':
        return (
          <>
            <circle cx="9" cy="8" r="3" />
            <path d="M3 20c0-4 2-7 6-7s6 3 6 7" />
            <circle cx="17" cy="9" r="2" />
            <path d="M16 14c3 0 5 2 5 6" />
          </>
        );
      case 'roles':
        return (
          <>
            <circle cx="8" cy="8" r="3" />
            <path d="M3 20c0-4 1.5-7 5-7 1.5 0 2.6.5 3.4 1.4" />
            <path d="m17 13 1 2 2 .5-1.5 1.5.5 2-2-.8-2 .8.5-2-1.5-1.5 2-.5 1-2Z" />
          </>
        );
      case 'audit':
        return (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2M8 3l-2-1M16 3l2-1" />
          </>
        );
      case 'search':
        return (
          <>
            <circle cx="11" cy="11" r="7" />
            <path d="m16 16 5 5" />
          </>
        );
      case 'building':
        return (
          <>
            <path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-5h6v5M8 10h2m4 0h2m-8 3h2m4 0h2" />
          </>
        );
      case 'bell':
        return (
          <>
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
            <path d="M10 21h4" />
          </>
        );
      case 'menu':
        return <path d="M4 7h16M4 12h16M4 17h16" />;
      case 'close':
        return <path d="m6 6 12 12M18 6 6 18" />;
      case 'chevron':
        return <path d="m9 18 6-6-6-6" />;
    }
  })();

  return (
    <svg {...common} {...props}>
      {glyph}
    </svg>
  );
}

export function OpsWingMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 52 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M2 5h8c5 0 8 2 12 7l2 3h4l2-3c4-5 7-7 12-7h8"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 10h6c3 0 5 1 8 5m28-5h-6c-3 0-5 1-8 5M18 18h16"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
