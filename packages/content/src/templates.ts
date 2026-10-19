import type { PageDocumentInput } from './schemas.js';

/**
 * UI-PUBLIC-2: starting points for the inner pages of the website, offered
 * when an editor creates a page in OPS. Like the default home page, they
 * only state what the platform really provides: dates, fares, itineraries,
 * seats and on-board equipment are read from Trips, Pricing and Fleet at
 * render time, and nothing here is a commercial promise (luggage allowance,
 * assistance hours, figures, labels) that the owner has not confirmed.
 */

const paragraph = (text: string) => ({ kind: 'paragraph' as const, spans: [{ text }] });

export interface PageTemplate {
  id: string;
  label: string;
  description: string;
  /** Suggested public path; the editor can change it. */
  path: string;
  document: PageDocumentInput;
}

type BlockInput = PageDocumentInput['blocks'][number];

const SERVICE_ITEMS = [
  {
    icon: 'ticket',
    title: 'Réservation en ligne',
    text: 'Choisissez votre départ et réservez votre place en quelques minutes.',
  },
  {
    icon: 'seat',
    title: 'Place choisie',
    text: 'Votre siège est sélectionné sur le plan du car et rappelé dans votre espace client.',
  },
  {
    icon: 'luggage',
    title: 'Bagages identifiés',
    text: 'Vos bagages sont étiquetés au départ et suivis pendant tout le trajet.',
  },
  {
    icon: 'pin',
    title: 'Suivi du trajet',
    text: 'Un lien de suivi peut être partagé pour connaître l’avancée du voyage.',
  },
] as const;

function tripPage(from: { code: string; city: string }, to: { code: string; city: string }) {
  const route = `${from.city} → ${to.city}`;
  const blocks: BlockInput[] = [
    {
      type: 'hero',
      variant: 'page',
      title: route,
      lead: `Votre voyage en autocar de ${from.city} à ${to.city}, réservé en ligne et suivi à chaque étape.`,
      journeyCard: false,
    },
    {
      type: 'sectionNav',
      label: 'Sur cette page',
      items: [
        { label: 'Départs', anchor: 'departs' },
        { label: 'Itinéraire', anchor: 'itineraire' },
        { label: 'Nos autocars', anchor: 'autocars' },
        { label: 'Services', anchor: 'services' },
        { label: 'Questions', anchor: 'questions' },
      ],
    },
    {
      type: 'departures',
      layout: 'dates',
      anchor: 'departs',
      kicker: 'Prochains départs',
      title: `Choisissez votre date de départ`,
      intro:
        'Les dates, places et prix affichés sont ceux des départs réellement ouverts à la réservation.',
      routes: [{ fromCode: from.code, toCode: to.code }],
      limit: 6,
    },
    {
      type: 'itinerary',
      anchor: 'itineraire',
      kicker: 'Itinéraire',
      title: `Le trajet ${route}`,
      intro: 'Horaires, arrêts et pays traversés du prochain départ programmé.',
      fromCode: from.code,
      toCode: to.code,
      includedTitle: 'Inclus dans votre voyage',
      included: [],
      showVehicleAmenities: true,
    },
    {
      type: 'fleet',
      anchor: 'autocars',
      kicker: 'Nos autocars',
      title: 'Les autocars en service',
      intro: 'Places et équipements à bord de chaque autocar, tels que la flotte les enregistre.',
      selection: 'all',
      items: [],
    },
    {
      type: 'cards',
      variant: 'services',
      anchor: 'services',
      kicker: 'Services',
      title: 'Votre voyage, accompagné à chaque étape.',
      items: [...SERVICE_ITEMS],
    },
    {
      type: 'faq',
      anchor: 'questions',
      kicker: 'Questions fréquentes',
      title: 'Préparer votre voyage.',
      items: [
        {
          question: 'Les horaires affichés sont-ils définitifs ?',
          answer: [
            paragraph(
              'Ce sont les horaires prévus du départ programmé. Ils peuvent évoluer avec la route ; votre espace client et le suivi du trajet indiquent les informations à jour.',
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
      title: `Réservez votre ${route}.`,
      text: 'Consultez les prochains départs et choisissez votre place.',
      button: { label: 'Rechercher un voyage', target: { kind: 'app', app: 'booking' } },
      tone: 'light',
    },
  ];
  return {
    title: route,
    seo: {
      title: `Autocar ${route} — EURO TERANGA`,
      description: `Voyagez en autocar de ${from.city} à ${to.city} : prochains départs, itinéraire, autocars et services. Réservation en ligne et choix du siège.`,
      indexable: true,
    },
    blocks,
  } satisfies PageDocumentInput;
}

export const PAGE_TEMPLATES: readonly PageTemplate[] = [
  {
    id: 'trip-paris-dakar',
    label: 'Voyage Paris → Dakar',
    description: 'Dates et prix, itinéraire du prochain départ, autocars, services et questions.',
    path: '/paris-dakar',
    document: tripPage({ code: 'PAR', city: 'Paris' }, { code: 'DKR', city: 'Dakar' }),
  },
  {
    id: 'trip-dakar-paris',
    label: 'Voyage Dakar → Paris',
    description: 'Dates et prix, itinéraire du prochain départ, autocars, services et questions.',
    path: '/dakar-paris',
    document: tripPage({ code: 'DKR', city: 'Dakar' }, { code: 'PAR', city: 'Paris' }),
  },
  {
    id: 'fleet',
    label: 'Nos bus',
    description: 'Les autocars en service, avec places, équipements et vos photos.',
    path: '/nos-bus',
    document: {
      title: 'Nos autocars',
      seo: {
        title: 'Nos autocars — EURO TERANGA',
        description:
          'Découvrez les autocars EURO TERANGA en service sur la ligne Paris ↔ Dakar : places, équipements à bord et photos.',
        indexable: true,
      },
      blocks: [
        {
          type: 'hero',
          variant: 'page',
          title: 'Nos autocars',
          lead: 'Les autocars en service sur la ligne Paris ↔ Dakar : places, équipements à bord et photos.',
          journeyCard: false,
        },
        {
          type: 'fleet',
          anchor: 'autocars',
          title: 'Les autocars en service',
          intro:
            'Les équipements indiqués sont ceux que la flotte enregistre pour chaque autocar. Celui qui assure votre départ est précisé sur la page du voyage.',
          selection: 'all',
          items: [],
        },
        {
          type: 'cta',
          kicker: 'Prêt à partir ?',
          title: 'Trouvez votre prochain départ.',
          text: 'Consultez les départs ouverts et choisissez votre place sur le plan du car.',
          button: { label: 'Rechercher un voyage', target: { kind: 'app', app: 'booking' } },
          tone: 'light',
        },
      ],
    },
  },
  {
    id: 'services',
    label: 'Services',
    description: 'Les services de la plateforme, avec vos photos, et un appel à réserver.',
    path: '/services',
    document: {
      title: 'Nos services',
      seo: {
        title: 'Nos services — EURO TERANGA',
        description:
          'Réservation en ligne, choix du siège, bagages identifiés, suivi du trajet et espace client : les services EURO TERANGA pour voyager entre Paris et Dakar.',
        indexable: true,
      },
      blocks: [
        {
          type: 'hero',
          variant: 'page',
          title: 'Nos services',
          titleAccent: 'pour un voyage serein',
          lead: 'De la réservation à l’arrivée, tout est pensé pour vous accompagner.',
          journeyCard: false,
        },
        {
          type: 'cards',
          variant: 'services',
          anchor: 'services',
          title: 'Ce qui vous accompagne',
          items: [
            ...SERVICE_ITEMS,
            {
              icon: 'support',
              title: 'Espace client',
              text: 'Réservations, passagers, documents et bagages réunis au même endroit.',
            },
            {
              icon: 'shield',
              title: 'Départs préparés',
              text: 'Chaque départ est préparé : car et documents vérifiés avant la route.',
            },
          ],
        },
        {
          type: 'cta',
          tone: 'dark',
          kicker: 'Suivi du trajet',
          title: 'Gardez un œil sur la route.',
          text: 'Avec le lien de suivi transmis pour votre voyage, consultez la progression du car.',
          button: { label: 'Ouvrir le suivi', target: { kind: 'app', app: 'tracking' } },
          illustration: 'tracking',
        },
        {
          type: 'cta',
          kicker: 'Prêt à partir ?',
          title: 'Votre prochain voyage commence ici.',
          text: 'Consultez les prochains départs et choisissez votre place.',
          button: { label: 'Rechercher un voyage', target: { kind: 'app', app: 'booking' } },
          tone: 'light',
        },
      ],
    },
  },
];
