import type { Navigation, PageDocumentInput, SiteSettings } from './schemas.js';

/**
 * Initial content of the public website, created once by the content
 * bootstrap and then owned by the editors in OPS. Nothing here is a legal,
 * commercial or contact fact: unknown owner information stays `null`
 * (OWNER_INPUT_REQUIRED) and no price is written (Pricing owns fares).
 */
export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  brandName: 'EURO TERANGA',
  slogan: 'Paris ↔ Dakar, la route qui rapproche.',
  contact: { email: null, phone: null, address: null, hours: null },
  legal: {
    companyName: null,
    legalForm: null,
    registeredAddress: null,
    shareCapital: null,
    registrationNumber: null,
    vatNumber: null,
    publicationDirector: null,
    hostName: null,
    hostAddress: null,
    hostContact: null,
  },
  privacy: {
    dataController: null,
    privacyContact: null,
    purposesAndLegalBases: null,
    retentionPeriods: null,
    processors: null,
    transfersOutsideEu: null,
  },
  social: [],
  apps: {
    bookingUrl: 'https://booking.euroteranga.com/',
    clientUrl: 'https://client.euroteranga.com/',
    trackingUrl: 'https://tracking.euroteranga.com/',
  },
  footer: {
    intro:
      'Voyages en autocar entre l’Europe et l’Afrique de l’Ouest, avec une première ligne Paris ↔ Dakar.',
  },
};

export const DEFAULT_NAVIGATION: Navigation = {
  header: [
    { label: 'Trajets', target: { kind: 'anchor', id: 'trajets' } },
    { label: 'Services', target: { kind: 'anchor', id: 'services' } },
    { label: 'Suivi', target: { kind: 'anchor', id: 'suivi' } },
    { label: 'Aide', target: { kind: 'anchor', id: 'aide' } },
  ],
  headerCta: { label: 'Réserver', target: { kind: 'app', app: 'booking' } },
  footer: [
    {
      title: 'Voyager',
      links: [
        { label: 'Réserver', target: { kind: 'app', app: 'booking' } },
        { label: 'Nos trajets', target: { kind: 'anchor', id: 'trajets' } },
        { label: 'Suivre un trajet', target: { kind: 'app', app: 'tracking' } },
      ],
    },
    {
      title: 'Mon voyage',
      links: [
        { label: 'Mon compte', target: { kind: 'app', app: 'client' } },
        { label: 'Services', target: { kind: 'anchor', id: 'services' } },
        { label: 'Questions fréquentes', target: { kind: 'anchor', id: 'aide' } },
      ],
    },
  ],
};

const paragraph = (text: string) => ({ kind: 'paragraph' as const, spans: [{ text }] });

export const DEFAULT_HOME_PAGE: PageDocumentInput = {
  title: 'Accueil',
  seo: {
    title: 'EURO TERANGA — Autocar Paris ↔ Dakar',
    description:
      'Voyagez en autocar entre Paris et Dakar avec EURO TERANGA : réservation en ligne, choix du siège, bagages identifiés et suivi du trajet.',
    indexable: true,
  },
  blocks: [
    {
      type: 'hero',
      eyebrow: 'Paris ↔ Dakar',
      title: 'Voyagez entre l’Europe et l’Afrique',
      titleAccent: 'en toute confiance',
      lead: 'Confort, sécurité, ponctualité et esprit Teranga : réservez votre place et voyagez accompagné, du départ jusqu’à l’arrivée.',
      note: 'Seuls les départs réellement programmés sont proposés à la réservation.',
      journeyCard: false,
      search: { fromCode: 'PAR', toCode: 'DKR' },
    },
    {
      type: 'cards',
      variant: 'highlights',
      title: 'Pourquoi voyager avec EURO TERANGA',
      items: [
        { icon: 'ticket', title: 'Réservation en ligne', text: 'Votre siège choisi à l’avance' },
        { icon: 'route', title: 'Ligne Paris ↔ Dakar', text: 'Dans les deux sens' },
        { icon: 'luggage', title: 'Bagages identifiés', text: 'Étiquetés et suivis' },
        { icon: 'pin', title: 'Suivi du trajet', text: 'À chaque étape du voyage' },
        { icon: 'shield', title: 'Départs préparés', text: 'Car et documents vérifiés' },
        { icon: 'support', title: 'Espace client', text: 'Tout votre voyage réuni' },
      ],
    },
    {
      type: 'departures',
      anchor: 'trajets',
      kicker: 'Réserver',
      title: 'Nos prochains départs',
      intro:
        'Les dates, places et prix affichés sont ceux des départs réellement ouverts à la réservation.',
      routes: [
        { fromCode: 'PAR', toCode: 'DKR' },
        { fromCode: 'DKR', toCode: 'PAR' },
      ],
      limit: 3,
      cta: { label: 'Voir tous les voyages', target: { kind: 'app', app: 'booking' } },
    },
    {
      type: 'textImage',
      tone: 'navy',
      kicker: 'L’esprit Teranga',
      title: 'La Teranga à chaque étape',
      body: [
        paragraph(
          'Plus qu’un trajet : une route humaine entre l’Europe et l’Afrique. Une équipe qui prépare chaque départ, des proches qui suivent le voyage, et un accueil fidèle à l’hospitalité sénégalaise.',
        ),
      ],
      illustration: 'coach',
      imageSide: 'end',
      cta: { label: 'Rechercher un voyage', target: { kind: 'app', app: 'booking' } },
    },
    {
      type: 'cards',
      variant: 'steps',
      kicker: 'En trois étapes',
      title: 'Choisissez, réservez, voyagez.',
      items: [
        {
          title: 'Trouvez votre départ',
          text: 'Comparez les prochains départs entre Paris et Dakar et choisissez votre date.',
        },
        {
          title: 'Choisissez votre place',
          text: 'Sélectionnez votre siège sur le plan du car, puis confirmez votre réservation.',
        },
        {
          title: 'Préparez votre voyage',
          text: 'Retrouvez votre réservation, vos passagers et vos bagages dans votre espace client.',
        },
      ],
    },
    {
      type: 'cards',
      variant: 'services',
      anchor: 'services',
      kicker: 'Services',
      title: 'Votre voyage, accompagné à chaque étape.',
      intro:
        'Les équipements à bord sont précisés pour chaque départ selon le car effectivement affecté.',
      items: [
        {
          icon: 'seat',
          title: 'Place réservée',
          text: 'Votre siège est attribué dès la réservation et rappelé dans votre espace client.',
        },
        {
          icon: 'luggage',
          title: 'Bagages',
          text: 'Vos bagages sont enregistrés au départ et suivis pendant tout le trajet.',
        },
        {
          icon: 'pin',
          title: 'Suivi en ligne',
          text: 'Un lien de suivi peut être partagé pour connaître l’avancée du voyage.',
        },
        {
          icon: 'support',
          title: 'Espace client',
          text: 'Réservations, passagers et informations utiles réunis au même endroit.',
        },
      ],
    },
    {
      type: 'cta',
      anchor: 'suivi',
      kicker: 'Suivi du trajet',
      title: 'Gardez un œil sur la route.',
      text: 'Avec le lien de suivi transmis pour votre voyage, consultez la progression du car en toute simplicité.',
      button: { label: 'Ouvrir le suivi', target: { kind: 'app', app: 'tracking' } },
      tone: 'dark',
      illustration: 'tracking',
    },
    {
      type: 'faq',
      anchor: 'aide',
      kicker: 'Questions fréquentes',
      title: 'Préparez votre voyage.',
      items: [
        {
          question: 'Comment savoir si un départ est disponible ?',
          answer: [
            paragraph(
              'L’espace de réservation affiche uniquement les départs programmés et ouverts, avec le nombre de places encore libres.',
            ),
          ],
        },
        {
          question: 'Puis-je choisir ma place ?',
          answer: [
            paragraph(
              'Oui. Au moment de réserver, le plan du car indique les sièges disponibles pour votre trajet.',
            ),
          ],
        },
        {
          question: 'Comment suivre mon trajet ?',
          answer: [
            paragraph(
              'Ouvrez le lien de suivi communiqué pour votre voyage. Les informations affichées dépendent du suivi activé pour ce départ.',
            ),
          ],
        },
        {
          question: 'Où retrouver ma réservation ?',
          answer: [
            paragraph(
              'Dans votre espace client, avec vos passagers, vos bagages et les informations de votre voyage.',
            ),
          ],
        },
      ],
    },
    {
      type: 'cta',
      kicker: 'Prêt à partir ?',
      title: 'Votre prochain Paris ↔ Dakar commence ici.',
      text: 'Consultez les prochains départs et choisissez votre place.',
      button: { label: 'Rechercher un voyage', target: { kind: 'app', app: 'booking' } },
      tone: 'light',
    },
  ],
};
