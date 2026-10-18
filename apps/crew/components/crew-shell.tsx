import Link from 'next/link';
import type { ReactNode } from 'react';

export function CrewShell({
  title,
  subtitle,
  environment,
  children,
}: {
  title: string;
  subtitle?: string;
  environment: string;
  children: ReactNode;
}) {
  return (
    <div className="crew-shell">
      <a className="et-skip-link" href="#main">
        Aller au contenu
      </a>

      <header className="crew-topbar">
        <Link
          className="crew-brand"
          href="/"
          prefetch={false}
          aria-label="EURO TERANGA Crew — accueil"
        >
          <span className="crew-brand__mark" aria-hidden="true">
            ET
          </span>
          <span>
            EURO <strong>TERANGA</strong>
          </span>
          <span className="crew-brand__product">CREW</span>
        </Link>
        <nav className="crew-topbar__nav" aria-label="Navigation équipage">
          <Link href="/session" prefetch={false}>
            Session terrain
          </Link>
          <Link href="/connexion" prefetch={false}>
            Connexion
          </Link>
        </nav>
      </header>

      <main id="main" className="crew-main" tabIndex={-1}>
        <header className="crew-page-header">
          <p className="crew-page-kicker">Application terrain</p>
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </header>
        <div className="crew-page-content">{children}</div>
      </main>

      <footer className="crew-footer">
        <div>
          <strong>EURO TERANGA Crew</strong>
          <span>Mode terrain · synchronisation sécurisée</span>
        </div>
        <span>{environment}</span>
      </footer>
    </div>
  );
}
