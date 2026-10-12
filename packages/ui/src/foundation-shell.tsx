import type { ReactNode } from 'react';
import { BrandMark } from './brand-mark.js';

export interface FoundationShellProps {
  /** Application name next to the brand mark. */
  product?: string;
  /** Page heading (the single h1 of the page). */
  title: string;
  subtitle?: string;
  /** Deployment environment label, e.g. "local" or "ci". */
  environment: string;
  /** Optional navigation rendered in the header. */
  navigation?: ReactNode;
  children?: ReactNode;
}

/**
 * Common page frame for foundation skeletons: skip link, banner, main and
 * contentinfo landmarks, a single h1, and an explicit "under development"
 * notice so that no page can be mistaken for an available service.
 */
export function FoundationShell({
  product,
  title,
  subtitle,
  environment,
  navigation,
  children,
}: FoundationShellProps) {
  return (
    <>
      <a className="et-skip-link" href="#main">
        Aller au contenu
      </a>
      <header className="et-header">
        <BrandMark {...(product ? { product } : {})} />
        {navigation}
      </header>
      <main id="main" className="et-main" tabIndex={-1}>
        <h1>{title}</h1>
        {subtitle ? <p className="et-subtitle">{subtitle}</p> : null}
        {children}
      </main>
      <footer className="et-footer">
        <p>
          <strong className="et-status">Platform under development</strong>
          <span aria-hidden="true"> · </span>
          <span>Environnement : {environment}</span>
        </p>
      </footer>
    </>
  );
}
