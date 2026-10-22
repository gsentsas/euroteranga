import {
  DEFAULT_NAVIGATION,
  DEFAULT_SITE_SETTINGS,
  PAGE_TEMPLATES,
  pageDocumentSchema,
  type PageDocument,
} from '@euroteranga/content';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SiteContext, SiteMedia } from './blocks.js';
import type { SiteDeparture } from './departures.js';
import type { SiteVehicle } from './fleet.js';
import { journeyItinerary, type ItineraryResult, type PublicItinerary } from './itinerary.js';
import { formatPrice } from './money.js';
import { SitePage } from './shell.js';

/** Synthetic test data only: no real schedule, fare or vehicle. */
const ctx = (overrides: Partial<SiteContext> = {}): SiteContext => ({
  settings: DEFAULT_SITE_SETTINGS,
  navigation: DEFAULT_NAVIGATION,
  apps: {
    booking: 'https://booking.example/',
    client: 'https://client.example/',
    tracking: 'https://tracking.example/',
  },
  fromPrices: {},
  year: 2030,
  ...overrides,
});

const render = (document: PageDocument, context: SiteContext) =>
  renderToStaticMarkup(<SitePage title={document.title} blocks={document.blocks} ctx={context} />);

const template = (id: string) =>
  pageDocumentSchema.parse(PAGE_TEMPLATES.find((candidate) => candidate.id === id)!.document);

const paris = {
  code: 'PAR',
  name: 'Gare routière',
  locality: 'Paris',
  countryName: 'France',
  timezone: 'Europe/Paris',
};
const dakar = {
  code: 'DKR',
  name: 'Gare routière',
  locality: 'Dakar',
  countryName: 'Sénégal',
  timezone: 'Africa/Dakar',
};
const fare = (euros: number) => ({
  amountMinor: euros * 100,
  currencyCode: 'EUR',
  currencyMinorUnit: 2,
});
const departures: SiteDeparture[] = [
  {
    tripId: 'trip-1',
    from: paris,
    to: dakar,
    departureAt: '2030-11-12T07:00:00.000Z',
    availableSeats: 3,
    fare: fare(249),
  },
  {
    tripId: 'trip-2',
    from: paris,
    to: dakar,
    departureAt: '2030-11-26T07:00:00.000Z',
    availableSeats: 40,
    fare: fare(259),
  },
];

const country = (iso2: string, name: string) => ({ iso2, name });
const waypoint = (
  id: string,
  locality: string,
  place: { iso2: string; name: string },
  overrides: Partial<PublicItinerary['waypoints'][number]> = {},
): PublicItinerary['waypoints'][number] => ({
  routeWaypointId: id,
  kind: 'STOP',
  name: 'Gare routière',
  locality,
  timezone: 'Etc/UTC',
  country: place,
  checkpointType: null,
  terangaStopKind: null,
  facilities: [],
  plannedArrivalAt: null,
  plannedDepartureAt: null,
  ...overrides,
});
const publicItinerary = (vehicle: PublicItinerary['vehicle']): PublicItinerary => ({
  tripId: 'trip-1',
  vehicle,
  waypoints: [
    waypoint('w1', 'Paris', country('FR', 'France'), {
      timezone: 'Europe/Paris',
      plannedDepartureAt: '2030-11-12T07:00:00.000Z',
    }),
    waypoint('w2', 'Madrid', country('ES', 'Espagne'), {
      timezone: 'Europe/Madrid',
      plannedArrivalAt: '2030-11-12T19:00:00.000Z',
    }),
    waypoint('w3', 'Rosso', country('MR', 'Mauritanie'), {
      kind: 'CHECKPOINT',
      name: 'Poste frontière',
      checkpointType: 'BORDER',
      terangaStopKind: 'BORDER',
      facilities: ['RESTROOM'],
      plannedArrivalAt: '2030-11-13T20:00:00.000Z',
    }),
    waypoint('w4', 'Dakar', country('SN', 'Sénégal'), {
      timezone: 'Africa/Dakar',
      plannedArrivalAt: '2030-11-14T00:30:00.000Z',
    }),
  ],
});
const itineraryOf = (vehicle: PublicItinerary['vehicle']): ItineraryResult => ({
  status: 'ok',
  itinerary: journeyItinerary(publicItinerary(vehicle), 'w1', 'w4')!,
});

const coach = (code: string, overrides: Partial<SiteVehicle> = {}): SiteVehicle => ({
  code,
  name: null,
  manufacturer: 'Constructeur',
  model: 'Modèle',
  modelYear: null,
  amenities: [],
  seatCount: null,
  ...overrides,
});

describe('trip pages (UI-PUBLIC-2)', () => {
  const page = template('trip-paris-dakar');
  const tripCtx = (itinerary: ItineraryResult, fleet: readonly SiteVehicle[] | null = []) =>
    ctx({
      departures: (from, to) => (from === 'PAR' && to === 'DKR' ? departures : []),
      itineraries: (from, to) =>
        from === 'PAR' && to === 'DKR' ? itinerary : { status: 'unavailable' },
      fleet,
    });

  it('renders one H1 with its breadcrumb and section tabs that all lead somewhere', () => {
    const html = render(page, tripCtx(itineraryOf(null)));
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('<nav class="public-breadcrumb" aria-label="Fil d’Ariane">');
    expect(html).toMatch(/<a href="\/">Accueil<\/a>/);
    expect(html).toMatch(/<li aria-current="page">.*Paris → Dakar<\/li>/);
    expect(html).toContain('<nav class="public-section-nav" aria-label="Sur cette page">');
    for (const anchor of html.matchAll(/class="public-section-nav".*?<\/nav>/g)) {
      for (const [, id] of anchor[0].matchAll(/href="#([a-z-]+)"/g)) {
        expect(html, id).toContain(`id="${id}"`);
      }
    }
  });

  it('lists the real departure dates with their Pricing fares and books the soonest one', () => {
    const html = render(page, tripCtx(itineraryOf(null)));
    expect(html).toContain('<ul class="public-dates"');
    expect(html).toMatch(/dateTime="2030-11-12T07:00:00.000Z">mar\. 12 nov\.<\/time>/);
    // Exact Pricing amounts, formatted like everywhere else on the website.
    for (const price of [fare(249), fare(259)]) {
      expect(html).toContain(`<strong class="public-date__price">${formatPrice(price)}</strong>`);
    }
    expect(html).toContain('Plus que 3 places');
    expect(html).toContain(
      'href="https://booking.example/?from=PAR&amp;to=DKR&amp;date=2030-11-26"',
    );
    expect(html).toMatch(
      /class="public-button public-button--gold public-dates__book" href="https:\/\/booking\.example\/\?from=PAR&amp;to=DKR&amp;date=2030-11-12">Réserver ce voyage/,
    );
  });

  it('shows the planned itinerary in local times, with its duration, crossings and countries', () => {
    const html = render(page, tripCtx(itineraryOf(null)));
    // 07:00 UTC is 08:00 in Paris; the arrival is two calendar days later in Dakar.
    expect(html).toContain('<time dateTime="2030-11-12T07:00:00.000Z">08:00</time>');
    expect(html).toContain('<time dateTime="2030-11-14T00:30:00.000Z">00:30</time>');
    expect(html).toMatch(/\(\+2 j<span class="et-visually-hidden">ours<\/span>\)/);
    expect(html).toContain('Durée prévue : 41 h 30');
    expect(html).toContain('1 arrêt et 1 passage en cours de route');
    expect(html).toContain('Passage de frontière : Rosso — Poste frontière (Mauritanie)');
    expect(html).toContain('(France, Espagne, Mauritanie, Sénégal)');
    expect(html).toMatch(/public-countries__code" aria-hidden="true">SN<\/span>Sénégal/);
    // Nothing is included without the editor's list or a coach: the panel is left out.
    expect(html).not.toContain('Inclus dans votre voyage');
  });

  it('lists only the equipment the assigned coach really has, next to the confirmed services', () => {
    const withCoach = itineraryOf({
      name: 'Coach test',
      manufacturer: 'Constructeur',
      model: 'Modèle',
      amenities: ['AIR_CONDITIONING', 'USB_CHARGING', 'NOT_A_REAL_AMENITY'],
    });
    const edited = pageDocumentSchema.parse({
      ...page,
      blocks: page.blocks.map((block) =>
        block.type === 'itinerary' ? { ...block, included: ['Service confirmé'] } : block,
      ),
    });
    const html = render(edited, tripCtx(withCoach));
    expect(html).toContain('Inclus dans votre voyage');
    expect(html).toContain('Service confirmé');
    expect(html).toContain('Climatisation');
    expect(html).toContain('Prises USB');
    expect(html).toContain('Équipements de l’autocar Coach test, prévu pour ce départ.');
    for (const absent of ['Wi-Fi', 'Toilettes', 'Divertissement', 'fauteuil', 'NOT_A_REAL']) {
      expect(html).not.toContain(absent);
    }
    // The editor can leave the coach equipment out.
    const hidden = pageDocumentSchema.parse({
      ...edited,
      blocks: edited.blocks.map((block) =>
        block.type === 'itinerary' ? { ...block, showVehicleAmenities: false } : block,
      ),
    });
    expect(render(hidden, tripCtx(withCoach))).not.toContain('Climatisation');
  });

  it('says so when no departure is scheduled, or when the itinerary cannot be read', () => {
    expect(render(page, tripCtx({ status: 'none' }))).toContain(
      'Aucun départ n’est programmé pour le moment sur ce trajet',
    );
    const unavailable = render(page, tripCtx({ status: 'unavailable' }));
    expect(unavailable).toContain('L’itinéraire ne peut pas être affiché pour le moment.');
    expect(unavailable).not.toContain('Durée prévue');
  });
});

describe('fleet page (UI-PUBLIC-2)', () => {
  const page = template('fleet');
  const photo = (id: string): SiteMedia => ({
    src: `https://api.example/v1/media/${id}/960.webp`,
    srcSet: `https://api.example/v1/media/${id}/960.webp 960w`,
    alt: `Photo ${id}`,
    width: 1600,
    height: 1000,
  });

  it('presents every active coach with its seats and only its real equipment', () => {
    const fleet = [
      coach('BUS_01', {
        name: 'Coach 01',
        modelYear: 2024,
        seatCount: 53,
        amenities: ['AIR_CONDITIONING', 'WIFI', 'TOILET'],
      }),
      coach('BUS_02', { name: 'Coach 02', seatCount: 49, amenities: ['RECLINING_SEATS'] }),
    ];
    const html = render(page, ctx({ fleet }));
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('<nav class="public-fleet-tabs"');
    expect(html).toContain('href="#autocar-bus_01">Coach 01</a>');
    expect(html).toContain('id="autocar-bus_02"');
    expect(html).toContain('Constructeur Modèle · 2024');
    expect(html).toContain('53 places');
    const second = html.slice(html.indexOf('id="autocar-bus_02"'));
    expect(second).toContain('Sièges inclinables');
    expect(second).not.toContain('Wi-Fi');
    expect(second).not.toContain('Climatisation');
    expect(html).not.toContain('Prises USB');
  });

  it('adds the editor photos and description, and never shows an inactive coach', () => {
    const listed = pageDocumentSchema.parse({
      ...page,
      blocks: page.blocks.map((block) =>
        block.type === 'fleet'
          ? {
              ...block,
              selection: 'listed',
              items: [
                {
                  vehicleCode: 'BUS_02',
                  mediaId: '01900000-0000-7000-8000-000000000001',
                  description: 'Description éditoriale.',
                  gallery: ['01900000-0000-7000-8000-000000000002'],
                },
                { vehicleCode: 'RETIRED_BUS' },
              ],
            }
          : block,
      ),
    });
    const html = render(
      listed,
      ctx({
        fleet: [coach('BUS_01', { name: 'Coach 01' }), coach('BUS_02', { name: 'Coach 02' })],
        media: (id) => photo(id),
      }),
    );
    expect(html).not.toContain('Coach 01');
    expect(html).not.toContain('RETIRED_BUS');
    expect(html).not.toContain('public-fleet-tabs');
    expect(html).toContain('Description éditoriale.');
    expect(html).toContain('alt="Photo 01900000-0000-7000-8000-000000000001"');
    expect(html).toMatch(
      /class="public-vehicle__gallery" role="region" aria-label="Photos de Coach 02" tabindex="0"/,
    );
    // No seat map and no equipment yet: said honestly, nothing invented.
    expect(html).toContain('Les équipements de cet autocar seront précisés prochainement.');
  });

  it('stops using CMS photos as soon as Fleet media is configured', () => {
    const listed = pageDocumentSchema.parse({
      ...page,
      blocks: page.blocks.map((block) =>
        block.type === 'fleet'
          ? {
              ...block,
              selection: 'listed',
              items: [
                {
                  vehicleCode: 'BUS_02',
                  mediaId: '01900000-0000-7000-8000-000000000001',
                  gallery: ['01900000-0000-7000-8000-000000000002'],
                },
              ],
            }
          : block,
      ),
    });
    const fleetPrimary = photo('fleet-primary');
    const html = render(
      listed,
      ctx({
        fleet: [
          coach('BUS_02', {
            name: 'Coach 02',
            primaryMedia: fleetPrimary,
            gallery: [],
          }),
        ],
        media: (id) => photo(id),
      }),
    );
    expect(html).toContain('alt="Photo fleet-primary"');
    expect(html).not.toContain('Photo 01900000-0000-7000-8000-000000000001');
    expect(html).not.toContain('Photo 01900000-0000-7000-8000-000000000002');
    expect(html).not.toContain('class="public-vehicle__gallery"');
  });

  it('distinguishes an empty fleet from a fleet that cannot be read', () => {
    expect(render(page, ctx({ fleet: [] }))).toContain(
      'Les autocars en service seront présentés ici.',
    );
    expect(render(page, ctx({ fleet: null }))).toContain(
      'Les autocars ne peuvent pas être présentés pour le moment.',
    );
  });
});

describe('services page (UI-PUBLIC-2)', () => {
  it('renders the services template as a page hero with photo-ready service cards', () => {
    const page = template('services');
    const html = render(page, ctx());
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('public-hero public-hero--page');
    expect(html).toContain('<span class="public-hero__accent">pour un voyage serein</span>');
    expect(html).toContain('class="public-services"');
    expect(html).not.toMatch(/\d\s?€|24\s?\/\s?7/);
  });
});
