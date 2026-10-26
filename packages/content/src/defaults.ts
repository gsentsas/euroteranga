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
      'Voyageurs, colis et fret entre l’Europe et l’Afrique de l’Ouest, avec une première ligne Paris ↔ Dakar.',
  },
};

/**
 * PUBLIC-HOME-1: the three services are reachable from the header and the
 * footer. Every link targets an anchor of the default home page or one of the
 * applications, so a new environment has no dead link.
 */
export const DEFAULT_NAVIGATION: Navigation = {
  header: [
    { label: 'Voyager', target: { kind: 'anchor', id: 'trajets' } },
    { label: 'Colis & fret', target: { kind: 'anchor', id: 'expeditions' } },
    { label: 'Services', target: { kind: 'anchor', id: 'services' } },
    { label: 'Suivi', target: { kind: 'anchor', id: 'suivi' } },
    { label: 'Aide', target: { kind: 'anchor', id: 'aide' } },
  ],
  headerCta: { label: 'Réserver', target: { kind: 'app', app: 'booking' } },
  footer: [
    {
      title: 'Voyager',
      links: [
        { label: 'Réserver un trajet', target: { kind: 'app', app: 'booking' } },
        { label: 'Prochains départs', target: { kind: 'anchor', id: 'trajets' } },
        { label: 'Espace client', target: { kind: 'app', app: 'client' } },
      ],
    },
    {
      title: 'Expédier',
      links: [
        { label: 'Colis & fret', target: { kind: 'anchor', id: 'expeditions' } },
        { label: 'Demander un devis', target: { kind: 'app', app: 'client' } },
        { label: 'Suivre un envoi', target: { kind: 'app', app: 'tracking' } },
      ],
    },
    {
      title: 'Aide',
      links: [
        { label: 'Comment ça marche', target: { kind: 'anchor', id: 'comment-ca-marche' } },
        { label: 'Questions fréquentes', target: { kind: 'anchor', id: 'aide' } },
      ],
    },
  ],
};

const paragraph = (text: string) => ({ kind: 'paragraph' as const, spans: [{ text }] });

/**
 * PUBLIC-HOME-1: Voyageurs, Colis and Fret from the first screen. Nothing is
 * invented: passenger booking opens the booking application, parcels and
 * freight are requested from the customer account (« Mes colis »), where the
 * team issues a quote, and tracking needs the link sent for a trip or a
 * shipment. No price, delay, weight or capacity is written here.
 */
export const DEFAULT_HOME_PAGE: PageDocumentInput = {
  title: 'Accueil',
  seo: {
    title: 'EURO TERANGA — Voyages, colis et fret Paris ↔ Dakar',
    description:
      'Voyagez en autocar entre Paris et Dakar, envoyez vos colis et organisez votre fret avec EURO TERANGA : réservation en ligne, devis depuis l’espace client et suivi.',
    indexable: true,
  },
  blocks: [
    {
      type: 'hero',
      eyebrow: 'Paris ↔ Dakar · Voyageurs · Colis · Fret',
      title: 'Voyagez et expédiez',
      titleAccent: 'entre l’Europe et l’Afrique',
      lead: 'EURO TERANGA relie Paris et Dakar pour vos voyages, vos colis et votre fret. Réservez votre place en ligne ou préparez votre envoi depuis votre espace client : l’équipe vous accompagne du départ jusqu’à l’arrivée.',
      primaryCta: { label: 'Envoyer un colis', target: { kind: 'anchor', id: 'expeditions' } },
      secondaryCta: {
        label: 'Demander un devis fret',
        target: { kind: 'anchor', id: 'expeditions' },
      },
      note: 'Seuls les départs réellement programmés sont proposés à la réservation.',
      illustration: 'services',
      journeyCard: false,
      search: { fromCode: 'PAR', toCode: 'DKR' },
    },
    {
      type: 'cards',
      variant: 'offers',
      anchor: 'services',
      kicker: 'Nos services',
      title: 'Voyageurs, colis ou fret : choisissez votre service',
      intro: 'Une même route entre l’Europe et le Sénégal, trois façons de l’emprunter.',
      items: [
        {
          icon: 'bus',
          title: 'Voyageurs',
          text: 'Paris ↔ Dakar en toute simplicité : réservez votre trajet, choisissez votre place et retrouvez les informations utiles dans votre espace client.',
          link: { label: 'Voir les prochains départs', target: { kind: 'anchor', id: 'trajets' } },
        },
        {
          icon: 'parcel',
          title: 'Colis',
          text: 'Envoyez vos colis entre l’Europe et le Sénégal : créez votre demande depuis votre espace client, l’équipe étudie l’envoi et vous transmet un devis.',
          link: { label: 'Envoyer un colis', target: { kind: 'app', app: 'client' } },
        },
        {
          icon: 'freight',
          title: 'Fret',
          text: 'Une solution pour vos marchandises et vos envois professionnels : décrivez votre besoin et recevez une proposition adaptée dans un devis.',
          link: { label: 'Demander un devis', target: { kind: 'app', app: 'client' } },
        },
      ],
    },
    {
      type: 'departures',
      anchor: 'trajets',
      kicker: 'Voyageurs',
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
      type: 'cards',
      variant: 'journeys',
      anchor: 'comment-ca-marche',
      kicker: 'Comment ça marche',
      title: 'Trois services, des étapes claires.',
      intro: 'Voyage, colis ou fret : voici comment se déroule chaque parcours avec EURO TERANGA.',
      items: [
        {
          icon: 'bus',
          title: 'Voyageurs',
          text: 'Trouvez votre départ parmi les dates ouvertes à la réservation.\nChoisissez votre place sur le plan du car.\nPréparez votre voyage dans votre espace client.',
          link: { label: 'Rechercher un voyage', target: { kind: 'app', app: 'booking' } },
        },
        {
          icon: 'parcel',
          title: 'Colis',
          text: 'Préparez votre envoi : format, poids et précautions utiles.\nCréez votre demande et recevez un devis avec les modalités de remise.\nSuivez son acheminement avec le lien transmis lorsque le suivi est activé.',
          link: { label: 'Préparer mon envoi', target: { kind: 'app', app: 'client' } },
        },
        {
          icon: 'freight',
          title: 'Fret',
          text: 'Décrivez votre besoin : marchandises, volume et contexte professionnel.\nRecevez une proposition détaillée dans un devis.\nOrganisez l’expédition avec l’équipe une fois le devis accepté.',
          link: { label: 'Demander un devis', target: { kind: 'app', app: 'client' } },
        },
      ],
    },
    {
      type: 'cards',
      variant: 'offers',
      anchor: 'expeditions',
      kicker: 'Colis & fret',
      title: 'Vous n’avez pas besoin de voyager pour emprunter la route EURO TERANGA',
      intro:
        'Colis personnels, effets, marchandises ou besoins professionnels : préparez votre envoi et demandez une solution adaptée.',
      items: [
        {
          icon: 'parcel',
          title: 'Envoyer un colis',
          text: 'Pour vos effets personnels et vos envois familiaux entre l’Europe et le Sénégal. Décrivez votre colis depuis votre espace client : l’équipe étudie la demande et vous transmet un devis.',
          link: { label: 'Préparer mon envoi', target: { kind: 'app', app: 'client' } },
        },
        {
          icon: 'freight',
          title: 'Organiser un fret',
          text: 'Pour vos marchandises et vos expéditions professionnelles. Les caractéristiques, les précautions et les modalités sont étudiées avec vous avant confirmation dans le devis.',
          link: { label: 'Demander un devis', target: { kind: 'app', app: 'client' } },
        },
      ],
    },
    {
      type: 'textImage',
      tone: 'navy',
      kicker: 'L’esprit Teranga',
      title: 'La Teranga à chaque étape',
      body: [
        { kind: 'heading', level: 3, text: 'Une route, plusieurs besoins' },
        paragraph(
          'Que vous voyagiez pour retrouver vos proches, que vous envoyiez un colis à votre famille ou que vous organisiez le transport de marchandises, EURO TERANGA vous accompagne entre l’Europe et le Sénégal.',
        ),
        paragraph(
          'Une équipe qui prépare chaque départ et chaque envoi, des proches qui suivent la route, et un accueil fidèle à l’hospitalité sénégalaise.',
        ),
      ],
      illustration: 'route',
      imageSide: 'end',
      cta: { label: 'Choisir un service', target: { kind: 'anchor', id: 'services' } },
    },
    {
      type: 'cards',
      variant: 'services',
      anchor: 'avantages',
      kicker: 'À chaque étape',
      title: 'Un accompagnement du départ à l’arrivée.',
      intro:
        'Les modalités de chaque voyage et de chaque envoi sont précisées avant confirmation. Les équipements à bord dépendent du car affecté au départ.',
      items: [
        {
          icon: 'seat',
          title: 'Place réservée',
          text: 'Votre siège est attribué dès la réservation et rappelé dans votre espace client.',
        },
        {
          icon: 'parcel',
          title: 'Devis avant prise en charge',
          text: 'Chaque colis ou fret est étudié, puis confirmé dans un devis avant toute prise en charge.',
        },
        {
          icon: 'pin',
          title: 'Suivi',
          text: 'Suivez l’avancement de votre trajet ou de votre envoi avec le lien transmis, lorsque le suivi est activé.',
        },
        {
          icon: 'support',
          title: 'Espace client',
          text: 'Réservations, voyageurs, demandes de colis et devis réunis au même endroit.',
        },
      ],
    },
    {
      type: 'cta',
      anchor: 'suivi',
      kicker: 'Suivi',
      title: 'Gardez un œil sur la route.',
      text: 'Avec le lien de suivi transmis pour votre voyage ou votre envoi, consultez sa progression en toute simplicité.',
      button: { label: 'Ouvrir le suivi', target: { kind: 'app', app: 'tracking' } },
      tone: 'dark',
      illustration: 'tracking',
    },
    {
      type: 'faq',
      anchor: 'aide',
      kicker: 'Questions fréquentes',
      title: 'Vos questions, nos réponses.',
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
          question: 'Comment envoyer un colis ou du fret ?',
          answer: [
            paragraph(
              'Créez une demande depuis votre espace client, rubrique « Mes colis ». L’équipe étudie votre envoi et vous transmet un devis ; les modalités de remise sont confirmées avant la prise en charge.',
            ),
          ],
        },
        {
          question: 'Comment suivre mon trajet ou mon envoi ?',
          answer: [
            paragraph(
              'Ouvrez le lien de suivi qui vous a été communiqué. Les informations affichées dépendent du suivi activé pour ce trajet ou cet envoi.',
            ),
          ],
        },
        {
          question: 'Où retrouver mes réservations et mes demandes ?',
          answer: [
            paragraph(
              'Dans votre espace client, avec vos voyageurs, vos bagages, vos demandes de colis et vos devis.',
            ),
          ],
        },
      ],
    },
    {
      type: 'cta',
      kicker: 'Prêt à partir ou à expédier ?',
      title: 'Votre prochain trajet ou votre prochain envoi commence ici.',
      text: 'Consultez les prochains départs ou préparez votre demande de colis et de fret.',
      button: { label: 'Choisir un service', target: { kind: 'anchor', id: 'services' } },
      tone: 'light',
    },
  ],
};
