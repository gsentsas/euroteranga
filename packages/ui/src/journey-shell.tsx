import type { ReactNode } from 'react';

export interface JourneyShellLinks {
  home: string;
  booking: string;
  client: string;
  tracking: string;
}

export interface JourneyShellProps {
  area: string;
  title: string;
  subtitle?: string;
  environment: string;
  current?: 'booking' | 'client' | 'tracking';
  links: JourneyShellLinks;
  children?: ReactNode;
}

function JourneyBrand() {
  return (
    <span className="et-journey-brand">
      <span className="et-journey-brand__mark" aria-hidden="true">
        <svg viewBox="0 0 32 22" fill="none">
          <rect x="3" y="3" width="26" height="14" rx="4" stroke="currentColor" strokeWidth="2" />
          <path d="M7 7h18v5H7V7Z" fill="currentColor" opacity=".2" />
          <circle cx="9" cy="18" r="2" fill="currentColor" />
          <circle cx="23" cy="18" r="2" fill="currentColor" />
          <path d="M3 13h26" stroke="currentColor" strokeWidth="2" />
        </svg>
      </span>
      <span className="et-journey-brand__word">
        EURO <strong>TERANGA</strong>
      </span>
    </span>
  );
}

export function JourneyShell({
  area,
  title,
  subtitle,
  environment,
  current,
  links,
  children,
}: JourneyShellProps) {
  const nav = [
    { key: 'home', href: links.home, label: 'Accueil' },
    { key: 'booking', href: links.booking, label: 'Réserver' },
    { key: 'client', href: links.client, label: 'Mon espace' },
    { key: 'tracking', href: links.tracking, label: 'Suivi' },
  ] as const;

  return (
    <div className="et-journey-page">
      <a className="et-skip-link" href="#main">
        Aller au contenu
      </a>

      <header className="et-journey-header">
        <div className="et-journey-container et-journey-header__inner">
          <a
            className="et-journey-home"
            href={links.home}
            aria-label="EURO TERANGA — Accueil"
          >
            <JourneyBrand />
          </a>
          <nav className="et-journey-nav" aria-label="Navigation voyageur">
            <ul>
              {nav.map((item) => (
                <li key={item.key}>
                  <a
                    href={item.href}
                    {...(current === item.key ? { 'aria-current': 'page' as const } : {})}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>

      <main id="main" className="et-journey-main" tabIndex={-1}>
        <section className="et-journey-hero">
          <div className="et-journey-container">
            <p className="et-journey-kicker">{area}</p>
            <h1>{title}</h1>
            {subtitle ? <p className="et-journey-subtitle">{subtitle}</p> : null}
          </div>
        </section>

        <div className="et-journey-container et-journey-content">{children}</div>
      </main>

      <footer className="et-journey-footer">
        <div className="et-journey-container et-journey-footer__inner">
          <div>
            <JourneyBrand />
            <p>Le parcours voyageur EURO TERANGA, de la réservation au suivi.</p>
          </div>
          <p>
            <strong>Plateforme pilote</strong>
            <span aria-hidden="true"> · </span>
            <span>Environnement : {environment}</span>
          </p>
        </div>
      </footer>
    </div>
  );
}
