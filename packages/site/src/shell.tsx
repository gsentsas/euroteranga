import type { ContentBlock, ContentLink } from '@euroteranga/content';
import type { ReactNode } from 'react';
import { Blocks, type SiteContext } from './blocks.js';
import { CoachMark, Icon } from './icons.js';
import { resolveHref } from './links.js';

function Brand({ name }: { name: string }) {
  const [first, ...rest] = name.split(' ');
  return (
    <span className="public-logo">
      <span className="public-logo__mark" aria-hidden="true">
        <CoachMark />
      </span>
      <span>
        {first} {rest.length > 0 ? <strong>{rest.join(' ')}</strong> : null}
      </span>
    </span>
  );
}

function NavLink({
  link,
  ctx,
  className,
}: {
  link: ContentLink;
  ctx: SiteContext;
  className?: string;
}) {
  return (
    <a className={className} href={resolveHref(link.target, ctx.apps)}>
      {link.label}
    </a>
  );
}

export function SiteHeader({ ctx }: { ctx: SiteContext }) {
  const { settings, navigation } = ctx;
  return (
    <header className="public-header">
      <div className="public-container public-header__inner">
        <a href="/" aria-label={`${settings.brandName} — Accueil`}>
          <Brand name={settings.brandName} />
        </a>
        {navigation.header.length > 0 ? (
          <nav className="public-nav" aria-label="Navigation principale">
            <ul>
              {navigation.header.map((link, index) => (
                <li key={index}>
                  <NavLink link={link} ctx={ctx} />
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <div className="public-header__actions">
          <a className="public-header__account" href={ctx.apps.client}>
            Mon compte
          </a>
          {navigation.headerCta ? (
            <a className="public-button" href={resolveHref(navigation.headerCta.target, ctx.apps)}>
              {navigation.headerCta.label} <Icon name="arrow" />
            </a>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ ctx }: { ctx: SiteContext }) {
  const { settings, navigation } = ctx;
  const contact = settings.contact;
  return (
    <footer className="public-footer">
      <div className="public-container public-footer__inner">
        <div>
          <a href="/" aria-label={`${settings.brandName} — Accueil`}>
            <Brand name={settings.brandName} />
          </a>
          <p className="public-footer__intro">{settings.footer.intro}</p>
          {contact.email || contact.phone ? (
            <ul className="public-footer__contact">
              {contact.email ? (
                <li>
                  <Icon name="mail" /> <span>{contact.email}</span>
                </li>
              ) : null}
              {contact.phone ? (
                <li>
                  <Icon name="phone" /> <span>{contact.phone}</span>
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
        {navigation.footer.map((column, index) => (
          <div key={index}>
            <h2>{column.title}</h2>
            <ul>
              {column.links.map((link, at) => (
                <li key={at}>
                  <NavLink link={link} ctx={ctx} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="public-container public-footer__bottom">
        <p>
          © {ctx.year} {settings.brandName}. Tous droits réservés.
        </p>
        {settings.footer.notice ? <p>{settings.footer.notice}</p> : null}
      </div>
    </footer>
  );
}

/** A complete public page: skip link, header, main content and footer. */
export function SitePage({
  title,
  blocks,
  ctx,
  banner,
}: {
  title: string;
  blocks: readonly ContentBlock[];
  ctx: SiteContext;
  /** Rendered above the header (e.g. the OPS preview notice). */
  banner?: ReactNode;
}) {
  return (
    <div className="public-site">
      {banner}
      <a className="et-skip-link" href="#main">
        Aller au contenu
      </a>
      <SiteHeader ctx={ctx} />
      <main id="main" tabIndex={-1}>
        <Blocks title={title} blocks={blocks} ctx={ctx} />
      </main>
      <SiteFooter ctx={ctx} />
    </div>
  );
}
