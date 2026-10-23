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
  {
    id: 'baggage',
    label: 'Bagages',
    description:
      'Préparer, enregistrer et retrouver les bagages associés au voyage, sans inventer de franchise ni de poids.',
    path: '/bagages',
    document: {
      title: 'Bagages',
      seo: {
        title: 'Bagages — EURO TERANGA',
        description:
          'Préparez vos bagages pour votre voyage EURO TERANGA : enregistrement au départ, identification et informations de suivi associées au trajet.',
        indexable: true,
      },
      blocks: [
        {
          type: 'hero',
          variant: 'page',
          title: 'Préparez vos bagages',
          lead: 'Les bagages pris en charge sont enregistrés au départ, identifiés et associés à votre voyage.',
          journeyCard: false,
        },
        {
          type: 'cards',
          variant: 'steps',
          title: 'Du départ à l’arrivée.',
          intro:
            'Cette page décrit le suivi dans la plateforme. Elle ne fixe ni franchise, ni poids maximal, ni supplément.',
          items: [
            {
              title: 'Préparez votre départ',
              text: 'Gardez les informations de votre voyage disponibles lorsque vous présentez vos bagages.',
            },
            {
              title: 'Enregistrement',
              text: 'Les bagages pris en charge au départ sont enregistrés et associés au voyage concerné.',
            },
            {
              title: 'Identification',
              text: 'L’identification permet de rattacher chaque bagage enregistré aux informations du voyage.',
            },
            {
              title: 'Suivi des événements',
              text: 'Les événements enregistrés permettent de retrouver l’historique de prise en charge dans la plateforme.',
            },
          ],
        },
        {
          type: 'richText',
          title: 'Les conditions applicables à votre départ',
          body: [
            paragraph(
              'Les quantités, limites de poids, éventuels suppléments et règles d’acceptation ne sont pas définis par cette page. Seules les conditions communiquées pour votre départ s’appliquent.',
            ),
            paragraph(
              'Si une information n’est pas affichée dans votre réservation ou votre espace client, ne la déduisez pas à partir d’un autre voyage.',
            ),
          ],
        },
        {
          type: 'faq',
          title: 'Questions sur les bagages',
          items: [
            {
              question: 'Pourquoi les bagages sont-ils enregistrés ?',
              answer: [
                paragraph(
                  'L’enregistrement relie le bagage au voyage et permet de conserver les événements de prise en charge associés.',
                ),
              ],
            },
            {
              question: 'Cette page indique-t-elle une franchise ou un poids maximum ?',
              answer: [
                paragraph(
                  'Non. Cette page ne fixe aucune franchise ni limite. Consultez uniquement les conditions communiquées pour votre départ.',
                ),
              ],
            },
            {
              question: 'Où retrouver les informations de mon voyage ?',
              answer: [
                paragraph(
                  'Votre espace client réunit votre réservation, vos passagers, vos bagages enregistrés et les informations utiles du voyage.',
                ),
              ],
            },
          ],
        },
        {
          type: 'cta',
          kicker: 'Votre voyage',
          title: 'Retrouvez vos informations dans votre espace client.',
          button: { label: 'Ouvrir mon espace', target: { kind: 'app', app: 'client' } },
          tone: 'light',
        },
      ],
    },
  },
  {
    id: 'how-it-works',
    label: 'Comment ça marche',
    description: 'Le parcours voyageur, de la recherche du départ au suivi du trajet.',
    path: '/comment-ca-marche',
    document: {
      title: 'Comment ça marche',
      seo: {
        title: 'Comment ça marche — EURO TERANGA',
        description:
          'Découvrez le parcours EURO TERANGA : rechercher un départ, choisir son siège, retrouver son voyage et suivre le trajet lorsqu’un suivi est activé.',
        indexable: true,
      },
      blocks: [
        {
          type: 'hero',
          variant: 'page',
          title: 'Comment ça marche',
          lead: 'De la recherche du départ à l’arrivée, la plateforme réunit les étapes utiles de votre voyage.',
          journeyCard: false,
        },
        {
          type: 'cards',
          variant: 'steps',
          title: 'Votre voyage, étape par étape.',
          items: [
            {
              icon: 'route',
              title: 'Trouvez votre départ',
              text: 'La réservation affiche les départs programmés et ouverts avec leurs informations disponibles.',
            },
            {
              icon: 'seat',
              title: 'Choisissez votre place',
              text: 'Le plan du car indique les sièges disponibles pour le voyage que vous préparez.',
            },
            {
              icon: 'ticket',
              title: 'Retrouvez votre réservation',
              text: 'Votre espace client rassemble les informations de votre voyage et de vos passagers.',
            },
            {
              icon: 'luggage',
              title: 'Préparez vos bagages',
              text: 'Les bagages pris en charge au départ sont enregistrés et associés au voyage.',
              link: { label: 'Voir la page Bagages', target: { kind: 'page', path: '/bagages' } },
            },
            {
              icon: 'pin',
              title: 'Suivez le trajet',
              text: 'Lorsqu’un suivi est activé pour le départ, le lien transmis permet de consulter sa progression.',
            },
          ],
        },
        {
          type: 'cta',
          kicker: 'Prochain départ',
          title: 'Commencez par rechercher votre voyage.',
          text: 'Consultez les départs ouverts et les places disponibles.',
          button: { label: 'Rechercher un voyage', target: { kind: 'app', app: 'booking' } },
          tone: 'light',
        },
      ],
    },
  },
  {
    id: 'faq',
    label: 'FAQ',
    description: 'Les réponses aux questions fréquentes sur la réservation et le voyage.',
    path: '/faq',
    document: {
      title: 'Questions fréquentes',
      seo: {
        title: 'Questions fréquentes — EURO TERANGA',
        description:
          'Retrouvez les réponses aux questions fréquentes sur les départs, le choix du siège, l’espace client, les bagages et le suivi du trajet.',
        indexable: true,
      },
      blocks: [
        {
          type: 'hero',
          variant: 'page',
          title: 'Questions fréquentes',
          lead: 'Les réponses essentielles pour préparer et retrouver les informations de votre voyage.',
          journeyCard: false,
        },
        {
          type: 'faq',
          anchor: 'questions',
          title: 'Préparer votre voyage.',
          items: [
            {
              question: 'Comment savoir si un départ est disponible ?',
              answer: [
                paragraph(
                  'L’espace de réservation affiche les départs programmés et ouverts ainsi que les places encore disponibles.',
                ),
              ],
            },
            {
              question: 'Puis-je choisir ma place ?',
              answer: [
                paragraph(
                  'Oui. Pour un départ ouvert à la réservation, le plan du car indique les sièges disponibles.',
                ),
              ],
            },
            {
              question: 'Où retrouver ma réservation ?',
              answer: [
                paragraph(
                  'Votre espace client réunit votre réservation, vos passagers, vos bagages enregistrés et les informations utiles du voyage.',
                ),
              ],
            },
            {
              question: 'Où consulter les conditions concernant mes bagages ?',
              answer: [
                paragraph(
                  'La page Bagages explique le fonctionnement de l’enregistrement. Les conditions applicables restent celles communiquées pour votre départ.',
                ),
              ],
            },
            {
              question: 'Comment suivre mon trajet ?',
              answer: [
                paragraph(
                  'Lorsqu’un suivi est activé pour votre départ, ouvrez le lien de suivi qui vous a été transmis. Les informations affichées dépendent du suivi configuré pour ce voyage.',
                ),
              ],
            },
          ],
        },
        {
          type: 'cta',
          title: 'Vous préparez un départ ?',
          text: 'Consultez les voyages ouverts à la réservation et leurs informations à jour.',
          button: { label: 'Rechercher un voyage', target: { kind: 'app', app: 'booking' } },
          tone: 'light',
        },
      ],
    },
  },
  {
    id: 'about',
    label: 'À propos',
    description: 'La liaison Paris ↔ Dakar et les services réunis dans la plateforme EURO TERANGA.',
    path: '/a-propos',
    document: {
      title: 'À propos d’EURO TERANGA',
      seo: {
        title: 'À propos — EURO TERANGA',
        description:
          'Découvrez EURO TERANGA et son parcours voyageur entre Paris et Dakar : réservation, siège, espace client, bagages et suivi du trajet.',
        indexable: true,
      },
      blocks: [
        {
          type: 'hero',
          variant: 'page',
          title: 'À propos d’EURO TERANGA',
          lead: 'Une expérience de voyage pensée autour de la liaison Paris ↔ Dakar et des informations utiles avant, pendant et après le départ.',
          journeyCard: false,
        },
        {
          type: 'textImage',
          kicker: 'Paris ↔ Dakar',
          title: 'Une route, un parcours voyageur.',
          body: [
            paragraph(
              'EURO TERANGA réunit dans une même plateforme la recherche des départs, la réservation, le choix du siège, l’espace client, les bagages enregistrés et le suivi du trajet lorsqu’il est activé.',
            ),
            paragraph(
              'Les dates, places, tarifs, autocars et itinéraires affichés proviennent des données opérationnelles du voyage concerné.',
            ),
          ],
          illustration: 'route',
          imageSide: 'end',
        },
        {
          type: 'cards',
          variant: 'highlights',
          title: 'Des informations reliées au voyage réel.',
          items: [
            {
              icon: 'clock',
              title: 'Départs programmés',
              text: 'Les pages voyage affichent les départs réellement ouverts et leurs horaires prévus.',
            },
            {
              icon: 'bus',
              title: 'Autocars en service',
              text: 'Places et équipements proviennent de la flotte enregistrée dans la plateforme.',
            },
            {
              icon: 'luggage',
              title: 'Bagages enregistrés',
              text: 'Les bagages pris en charge sont associés au voyage et à leur historique d’événements.',
            },
            {
              icon: 'pin',
              title: 'Suivi configuré',
              text: 'Le suivi public reflète uniquement les informations rendues visibles pour le trajet.',
            },
          ],
        },
        {
          type: 'textImage',
          tone: 'navy',
          kicker: 'L’esprit Teranga',
          title: 'La Teranga à chaque étape',
          body: [
            paragraph(
              'Plus qu’un trajet : une route humaine entre l’Europe et l’Afrique, avec des informations réunies pour préparer le départ et suivre le voyage.',
            ),
          ],
          illustration: 'coach',
          imageSide: 'end',
        },
        {
          type: 'cta',
          title: 'Découvrez les prochains départs.',
          button: { label: 'Rechercher un voyage', target: { kind: 'app', app: 'booking' } },
          tone: 'light',
        },
      ],
    },
  },
  {
    id: 'cargo-freight',
    label: 'Colis & fret',
    description:
      'Une page éditoriale pour présenter les envois Paris ↔ Dakar, le devis et le suivi sécurisé.',
    path: '/fret',
    document: {
      title: 'Colis & fret Paris ↔ Dakar',
      seo: {
        title: 'Colis & fret Paris ↔ Dakar — EURO TERANGA',
        description:
          'Envoyez vos colis et votre fret routier entre Paris et Dakar avec EURO TERANGA : prise en charge, suivi sécurisé et devis adapté à votre envoi.',
        indexable: true,
      },
      blocks: [
        {
          type: 'hero',
          variant: 'page',
          eyebrow: 'Colis & fret routier',
          title: 'Envoyez vos colis entre Paris et Dakar',
          titleAccent: 'avec un suivi à chaque étape',
          lead: 'EURO TERANGA accompagne les envois routiers dans les deux sens. Chaque prise en charge est confirmée après étude de la demande et établissement d’un devis.',
          primaryCta: {
            label: 'Demander un devis',
            target: { kind: 'anchor', id: 'questions' },
          },
          secondaryCta: {
            label: 'Comment fonctionne le suivi ?',
            target: { kind: 'anchor', id: 'suivi' },
          },
          journeyCard: false,
        },
        {
          type: 'sectionNav',
          label: 'Sur cette page',
          items: [
            { label: 'Services', anchor: 'services' },
            { label: 'Fonctionnement', anchor: 'fonctionnement' },
            { label: 'Directions', anchor: 'directions' },
            { label: 'Suivi', anchor: 'suivi' },
            { label: 'Questions', anchor: 'questions' },
          ],
        },
        {
          type: 'cards',
          variant: 'services',
          anchor: 'services',
          kicker: 'Services',
          title: 'Une prise en charge adaptée à votre envoi.',
          intro:
            'Les caractéristiques et les options sont étudiées avant confirmation dans le devis.',
          items: [
            {
              icon: 'luggage',
              title: 'Poids et volume',
              text: 'Décrivez le format de votre envoi pour permettre à l’équipe d’étudier sa prise en charge.',
            },
            {
              icon: 'route',
              title: 'Collecte et livraison',
              text: 'Ces options peuvent être étudiées selon le lieu, l’organisation du trajet et la demande.',
            },
            {
              icon: 'shield',
              title: 'Fragile ou professionnel',
              text: 'Signalez les précautions utiles ou le contexte professionnel avant toute confirmation.',
            },
            {
              icon: 'pin',
              title: 'Suivi sécurisé',
              text: 'Un lien confidentiel peut être transmis lorsque le partage du suivi est activé.',
            },
          ],
        },
        {
          type: 'cards',
          variant: 'steps',
          anchor: 'fonctionnement',
          kicker: 'Fonctionnement',
          title: 'Votre envoi, étape par étape.',
          intro:
            'La progression dépend de l’acceptation de l’envoi et de son affectation à un trajet.',
          items: [
            {
              title: 'Demande',
              text: 'Vous communiquez les caractéristiques utiles à l’étude de votre envoi.',
            },
            {
              title: 'Réception',
              text: 'L’équipe confirme les modalités pratiques de remise de l’envoi.',
            },
            {
              title: 'Inspection',
              text: 'La conformité de l’envoi et les précautions nécessaires sont vérifiées.',
            },
            {
              title: 'Affectation',
              text: 'L’envoi accepté est affecté à un trajet disponible.',
            },
            {
              title: 'Chargement',
              text: 'Le chargement est enregistré après les contrôles opérationnels.',
            },
            {
              title: 'Transport',
              text: 'L’envoi progresse avec le trajet auquel il a été affecté.',
            },
            {
              title: 'Arrivée',
              text: 'L’arrivée est enregistrée avant la préparation de la remise.',
            },
            {
              title: 'Mise à disposition ou livraison',
              text: 'La modalité convenue est confirmée par l’équipe en charge de l’envoi.',
            },
          ],
        },
        {
          type: 'cards',
          variant: 'trust',
          anchor: 'directions',
          kicker: 'Directions',
          title: 'Entre Paris et Dakar, dans les deux sens.',
          items: [
            {
              icon: 'route',
              title: 'Paris → Dakar',
              text: 'Une prise en charge routière étudiée selon la nature de l’envoi et le trajet disponible.',
            },
            {
              icon: 'route',
              title: 'Dakar → Paris',
              text: 'Le même accompagnement, avec des modalités confirmées avant la remise de l’envoi.',
            },
          ],
        },
        {
          type: 'textImage',
          anchor: 'suivi',
          kicker: 'Suivi sécurisé',
          title: 'Un accès transmis uniquement lorsqu’il est activé.',
          body: [
            paragraph(
              'Lorsque le partage est disponible pour votre envoi, EURO TERANGA peut vous transmettre un lien confidentiel pour consulter sa progression.',
            ),
            paragraph(
              'Il n’existe pas de recherche publique par identité ou par référence. Conservez le lien reçu et ne le partagez qu’avec les personnes concernées.',
            ),
          ],
          illustration: 'tracking',
          imageSide: 'end',
          tone: 'navy',
        },
        {
          type: 'faq',
          anchor: 'questions',
          kicker: 'Questions fréquentes',
          title: 'Préparer votre demande.',
          items: [
            {
              question: 'Quels envois peuvent être étudiés ?',
              answer: [
                paragraph(
                  'Colis, effets et fret professionnel peuvent être étudiés. L’acceptation dépend de leur nature, de leur conditionnement et des contraintes du trajet.',
                ),
              ],
            },
            {
              question: 'Comment indiquer le poids et le volume ?',
              answer: [
                paragraph(
                  'Communiquez des estimations aussi précises que possible ainsi que le nombre de pièces. L’équipe vous indiquera les vérifications nécessaires.',
                ),
              ],
            },
            {
              question: 'Puis-je signaler un envoi fragile ou professionnel ?',
              answer: [
                paragraph(
                  'Oui. Signalez-le dès la demande afin que les précautions et la possibilité de prise en charge soient étudiées.',
                ),
              ],
            },
            {
              question: 'La collecte ou la livraison est-elle toujours incluse ?',
              answer: [
                paragraph(
                  'Non. Ces options dépendent de la zone et de l’organisation disponible. Le devis précise uniquement les modalités confirmées.',
                ),
              ],
            },
            {
              question: 'Comment demander un devis ?',
              answer: [
                paragraph(
                  'Utilisez les coordonnées de contact publiées par EURO TERANGA en bas de page et décrivez les caractéristiques de l’envoi ainsi que la direction souhaitée.',
                ),
              ],
            },
            {
              question: 'Comment suivre mon envoi ?',
              answer: [
                paragraph(
                  'Si le partage du suivi est activé, un lien sécurisé vous est transmis. Aucun formulaire public ne permet de rechercher un envoi.',
                ),
              ],
            },
          ],
        },
        {
          type: 'cta',
          kicker: 'Paris ↔ Dakar',
          title: 'Préparez votre demande de fret.',
          text: 'Décrivez votre envoi à l’équipe : les modalités confirmées seront réunies dans un devis adapté.',
          button: {
            label: 'Demander un devis',
            target: { kind: 'anchor', id: 'questions' },
          },
          tone: 'light',
        },
      ],
    },
  },
];
