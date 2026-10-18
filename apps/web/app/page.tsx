import type { Metadata } from 'next';
import Link from 'next/link';
import { BOOKING_URL, CLIENT_URL, TRACKING_URL } from '../lib/links';
import { DEFAULT_DESCRIPTION, SITE_NAME, jsonLd, siteSeo } from '../lib/seo';

export const metadata: Metadata = { alternates: { canonical: '/' } };

/** Organization and WebSite only: no rating, review, offer or price is asserted. */
function StructuredData() {
  const seo = siteSeo();
  const url = seo.siteUrl.toString();
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${url}#organization`,
      name: SITE_NAME,
      url,
      logo: new URL('/icon.svg', seo.siteUrl).toString(),
      description: DEFAULT_DESCRIPTION,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': `${url}#website`,
      name: SITE_NAME,
      url,
      inLanguage: 'fr-FR',
      publisher: { '@id': `${url}#organization` },
    },
  ];
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(data) }} />;
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M5 12h14M14 7l5 5-5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="12" cy="10" r="2.2" fill="currentColor" />
    </svg>
  );
}

function TicketIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V9a3 3 0 0 0 0 6v1.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V15a3 3 0 0 0 0-6V7.5Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M12 8v8" stroke="currentColor" strokeWidth="2" strokeDasharray="2 2" />
    </svg>
  );
}

function LuggageIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7M6.5 7h11A1.5 1.5 0 0 1 19 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 17.5v-9A1.5 1.5 0 0 1 6.5 7Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M9 10v6M15 10v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3 19 6v5c0 4.8-2.9 8.1-7 10-4.1-1.9-7-5.2-7-10V6l7-3Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="m9 12 2 2 4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 22" fill="none">
      <rect x="3" y="3" width="26" height="14" rx="4" stroke="currentColor" strokeWidth="2" />
      <path d="M7 7h18v5H7V7Z" fill="currentColor" opacity=".18" />
      <circle cx="9" cy="18" r="2" fill="currentColor" />
      <circle cx="23" cy="18" r="2" fill="currentColor" />
      <path d="M3 13h26" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function Brand() {
  return (
    <span className="public-logo">
      <span className="public-logo__mark" aria-hidden="true">
        <BusIcon />
      </span>
      <span>
        EURO <strong>TERANGA</strong>
      </span>
    </span>
  );
}

export default function HomePage() {
  return (
    <div className="public-site">
      <StructuredData />
      <a className="et-skip-link" href="#main">
        Aller au contenu
      </a>

      <header className="public-header">
        <div className="public-container public-header__inner">
          <Link href="/" aria-label="EURO TERANGA — Accueil">
            <Brand />
          </Link>

          <nav className="public-nav" aria-label="Navigation principale">
            <ul>
              <li>
                <a href="#trajets">Trajets</a>
              </li>
              <li>
                <a href="#services">Services</a>
              </li>
              <li>
                <a href="#suivi">Suivi</a>
              </li>
              <li>
                <a href="#aide">Aide</a>
              </li>
            </ul>
          </nav>

          <div className="public-header__actions">
            <a className="public-header__account" href={CLIENT_URL}>
              Mon compte
            </a>
            <a className="public-button" href={BOOKING_URL}>
              Réserver <ArrowIcon />
            </a>
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <section className="public-hero" aria-labelledby="hero-title">
          <div className="public-container public-hero__inner">
            <div>
              <div className="public-eyebrow">
                <span className="public-eyebrow__dot" aria-hidden="true" />
                Paris ↔ Dakar · Ligne pilote
              </div>
              <h1 id="hero-title">Paris ↔ Dakar, la route qui rapproche.</h1>
              <p className="public-hero__lead">
                Une nouvelle façon de voyager entre l’Europe et l’Afrique : réservation en ligne,
                suivi du trajet et accompagnement de votre départ jusqu’à l’arrivée.
              </p>
              <div className="public-hero__actions">
                <a className="public-button public-button--gold" href={BOOKING_URL}>
                  Rechercher un voyage <ArrowIcon />
                </a>
                <a className="public-button public-button--secondary" href={TRACKING_URL}>
                  Suivre un trajet
                </a>
              </div>
              <p className="public-hero__note">
                <ShieldIcon />
                Plateforme pilote : les disponibilités réelles sont affichées dans l’espace de
                réservation.
              </p>
            </div>

            <div className="public-trip-card" aria-label="Aperçu de la liaison Paris Dakar">
              <div className="public-trip-card__top">
                <div>
                  <p className="public-trip-card__label">Tarif standard pilote</p>
                  <p className="public-trip-card__price">
                    249 € <small>/ place</small>
                  </p>
                </div>
                <span className="public-pill">Paris ↔ Dakar</span>
              </div>

              <div className="public-route-line">
                <div className="public-route-stop">
                  <span className="public-route-stop__dot" aria-hidden="true" />
                  <div>
                    <strong>Paris</strong>
                    <span>France · départ</span>
                  </div>
                  <span className="public-route-stop__flag" aria-hidden="true">
                    🇫🇷
                  </span>
                </div>
                <div className="public-route-stop">
                  <span className="public-route-stop__dot" aria-hidden="true" />
                  <div>
                    <strong>Dakar</strong>
                    <span>Sénégal · arrivée</span>
                  </div>
                  <span className="public-route-stop__flag" aria-hidden="true">
                    🇸🇳
                  </span>
                </div>
              </div>

              <div className="public-trip-card__features">
                <span className="public-trip-feature">
                  <TicketIcon /> Réservation numérique
                </span>
                <span className="public-trip-feature">
                  <PinIcon /> Suivi du trajet
                </span>
                <span className="public-trip-feature">
                  <LuggageIcon /> Gestion bagages
                </span>
                <span className="public-trip-feature">
                  <ShieldIcon /> Parcours contrôlé
                </span>
              </div>
            </div>
          </div>
        </section>

        <div className="public-container public-search-wrap">
          <section className="public-search" aria-label="Recherche rapide Paris Dakar">
            <div className="public-search__cell">
              <span className="public-search__icon">
                <PinIcon />
              </span>
              <div>
                <span className="public-search__label">Départ</span>
                <span className="public-search__value">Paris</span>
              </div>
            </div>
            <div className="public-search__swap" aria-hidden="true">
              <ArrowIcon />
            </div>
            <div className="public-search__cell">
              <span className="public-search__icon">
                <PinIcon />
              </span>
              <div>
                <span className="public-search__label">Destination</span>
                <span className="public-search__value">Dakar</span>
              </div>
            </div>
            <div className="public-search__cell">
              <div>
                <span className="public-search__label">À partir de</span>
                <span className="public-search__price">249 €*</span>
              </div>
            </div>
            <a className="public-button public-search__cta" href={BOOKING_URL}>
              Voir les voyages
            </a>
          </section>
          <p className="public-search__hint">
            * Tarif pilote indicatif, sous réserve de programmation, disponibilité et conditions du
            voyage.
          </p>
        </div>

        <section className="public-section">
          <div className="public-container">
            <div className="public-section__head">
              <p className="public-kicker">Voyager simplement</p>
              <h2>Tout ce qu’il faut pour partir l’esprit plus léger.</h2>
            </div>
            <div className="public-trust-grid">
              <article className="public-trust-card">
                <span className="public-card-icon">
                  <TicketIcon />
                </span>
                <h3>Réservation en ligne</h3>
                <p>
                  Consultez les départs disponibles et choisissez votre place depuis l’espace
                  Booking.
                </p>
              </article>
              <article className="public-trust-card">
                <span className="public-card-icon">
                  <PinIcon />
                </span>
                <h3>Suivi du trajet</h3>
                <p>
                  Quand il est activé pour votre voyage, retrouvez les informations de progression
                  du trajet.
                </p>
              </article>
              <article className="public-trust-card">
                <span className="public-card-icon">
                  <LuggageIcon />
                </span>
                <h3>Bagages identifiés</h3>
                <p>
                  Le parcours opérationnel intègre l’enregistrement et le suivi des bagages associés
                  au voyage.
                </p>
              </article>
              <article className="public-trust-card">
                <span className="public-card-icon">
                  <ShieldIcon />
                </span>
                <h3>Contrôles avant départ</h3>
                <p>
                  Le départ suit des étapes de préparation, de vérification et d’autorisation
                  opérationnelle.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="public-section public-section--muted" id="trajets">
          <div className="public-container">
            <div className="public-section__head">
              <p className="public-kicker">Notre ligne</p>
              <h2>Deux sens, une même expérience EURO TERANGA.</h2>
              <p className="public-section__intro">
                Les dates et horaires ne sont jamais inventés : seuls les voyages réellement
                programmés apparaissent à la réservation.
              </p>
            </div>
            <div className="public-route-grid">
              <article className="public-route-card">
                <div className="public-route-card__direction">France → Sénégal</div>
                <h3>Paris vers Dakar</h3>
                <p>La liaison longue distance pour rejoindre Dakar depuis la région parisienne.</p>
                <div className="public-route-card__bottom">
                  <div className="public-route-card__price">
                    <strong>249 €*</strong>
                    <span>tarif standard pilote</span>
                  </div>
                  <a className="public-route-card__link" href={BOOKING_URL}>
                    Voir les départs →
                  </a>
                </div>
              </article>
              <article className="public-route-card">
                <div className="public-route-card__direction">Sénégal → France</div>
                <h3>Dakar vers Paris</h3>
                <p>
                  Le trajet retour pensé pour relier Dakar à Paris avec le même parcours digital.
                </p>
                <div className="public-route-card__bottom">
                  <div className="public-route-card__price">
                    <strong>249 €*</strong>
                    <span>tarif standard pilote</span>
                  </div>
                  <a className="public-route-card__link" href={BOOKING_URL}>
                    Voir les départs →
                  </a>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="public-section">
          <div className="public-container">
            <div className="public-section__head">
              <p className="public-kicker">En trois étapes</p>
              <h2>Choisissez, réservez, voyagez.</h2>
            </div>
            <div className="public-steps">
              <article className="public-step-card">
                <h3>Trouvez votre départ</h3>
                <p>
                  Consultez les voyages programmés entre Paris et Dakar et sélectionnez votre
                  itinéraire.
                </p>
              </article>
              <article className="public-step-card">
                <h3>Choisissez votre place</h3>
                <p>
                  Visualisez les sièges disponibles et créez votre réservation depuis un parcours
                  sécurisé.
                </p>
              </article>
              <article className="public-step-card">
                <h3>Suivez votre voyage</h3>
                <p>
                  Accédez à votre espace client et aux informations de suivi disponibles pour votre
                  trajet.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="public-section public-section--muted" id="services">
          <div className="public-container">
            <div className="public-section__head">
              <p className="public-kicker">Services</p>
              <h2>Un parcours digital conçu autour du voyage.</h2>
              <p className="public-section__intro">
                Les prestations matérielles à bord sont précisées pour chaque départ selon le
                véhicule effectivement affecté.
              </p>
            </div>
            <div className="public-services">
              <article className="public-service-card">
                <span className="public-card-icon">
                  <TicketIcon />
                </span>
                <h3>Réservation en ligne</h3>
                <p>
                  Référence de réservation, siège et informations de voyage réunis au même endroit.
                </p>
              </article>
              <article className="public-service-card">
                <span className="public-card-icon">
                  <LuggageIcon />
                </span>
                <h3>Bagages</h3>
                <p>Enregistrement et événements de suivi intégrés au parcours opérationnel.</p>
              </article>
              <article className="public-service-card">
                <span className="public-card-icon">
                  <PinIcon />
                </span>
                <h3>Tracking</h3>
                <p>
                  Projection publique contrôlée selon le niveau de visibilité activé pour le trajet.
                </p>
              </article>
              <article className="public-service-card">
                <span className="public-card-icon">
                  <ShieldIcon />
                </span>
                <h3>Assistance voyage</h3>
                <p>
                  Compte client, informations utiles et historique de réservation accessibles en
                  ligne.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="public-section" id="suivi">
          <div className="public-container public-tracking">
            <div className="public-tracking__inner">
              <div>
                <p className="public-kicker">Suivi du trajet</p>
                <h2>Gardez un œil sur la route.</h2>
                <p>
                  Quand un lien de suivi public vous est communiqué, consultez les informations
                  rendues visibles pour votre voyage sans exposer les données opérationnelles
                  internes.
                </p>
                <a className="public-button public-button--gold" href={TRACKING_URL}>
                  Ouvrir le suivi <ArrowIcon />
                </a>
              </div>
              <div className="public-tracking__visual" aria-hidden="true">
                <span className="public-tracking__path" />
                <span className="public-tracking__pin public-tracking__pin--start" />
                <span className="public-tracking__pin public-tracking__pin--end" />
                <span className="public-tracking__bus">
                  <BusIcon />
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="public-section public-section--muted" id="aide">
          <div className="public-container">
            <div className="public-section__head">
              <p className="public-kicker">Questions fréquentes</p>
              <h2>Préparez votre voyage.</h2>
            </div>
            <div className="public-faq">
              <details>
                <summary>Comment savoir si un départ est réellement disponible ?</summary>
                <p>
                  Seuls les voyages programmés et ouverts apparaissent dans l’espace de réservation.
                  Un brouillon interne n’est jamais proposé au public.
                </p>
              </details>
              <details>
                <summary>Puis-je choisir ma place ?</summary>
                <p>
                  Oui, lorsqu’un voyage est ouvert à la réservation et qu’un plan de sièges est
                  affecté, les places disponibles sont proposées dans Booking.
                </p>
              </details>
              <details>
                <summary>Comment suivre mon trajet ?</summary>
                <p>
                  Utilisez le lien ou le jeton de suivi communiqué pour votre voyage. Les
                  informations affichées dépendent du niveau de visibilité activé.
                </p>
              </details>
              <details>
                <summary>Où retrouver ma réservation ?</summary>
                <p>
                  Votre espace client centralise vos réservations et les informations associées à
                  votre voyage.
                </p>
              </details>
            </div>
          </div>
        </section>

        <section className="public-section">
          <div className="public-container public-final-cta">
            <div>
              <p className="public-kicker">Prêt à partir ?</p>
              <h2>Votre prochain Paris ↔ Dakar commence ici.</h2>
              <p>Consultez les départs réellement ouverts et choisissez votre voyage.</p>
            </div>
            <a className="public-button" href={BOOKING_URL}>
              Rechercher un voyage <ArrowIcon />
            </a>
          </div>
        </section>
      </main>

      <footer className="public-footer">
        <div className="public-container public-footer__inner">
          <div>
            <Link href="/" aria-label="EURO TERANGA — Accueil">
              <Brand />
            </Link>
            <p className="public-footer__intro">
              Plateforme de transport longue distance entre l’Europe et l’Afrique, avec une première
              ligne pilote Paris ↔ Dakar.
            </p>
          </div>
          <div>
            <h2>Voyager</h2>
            <ul>
              <li>
                <a href={BOOKING_URL}>Réserver</a>
              </li>
              <li>
                <a href="#trajets">Trajets</a>
              </li>
              <li>
                <a href={TRACKING_URL}>Suivre un trajet</a>
              </li>
            </ul>
          </div>
          <div>
            <h2>Mon voyage</h2>
            <ul>
              <li>
                <a href={CLIENT_URL}>Mon compte</a>
              </li>
              <li>
                <a href="#services">Services</a>
              </li>
              <li>
                <a href="#aide">Aide</a>
              </li>
            </ul>
          </div>
          <div>
            <h2>EURO TERANGA</h2>
            <ul>
              <li>
                <a href="#aide">Questions fréquentes</a>
              </li>
              <li>
                <a href="#main">Retour en haut</a>
              </li>
            </ul>
          </div>
        </div>
        <div className="public-container public-footer__bottom">
          <p>© 2026 EURO TERANGA. Tous droits réservés.</p>
          <p>
            <span className="public-pilot-badge">Plateforme pilote</span> · services ouverts
            uniquement lorsqu’un voyage est effectivement programmé.
          </p>
        </div>
      </footer>
    </div>
  );
}
