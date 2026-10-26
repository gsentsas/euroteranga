'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { auth } from '../lib/auth';
import { OpsIcon } from './ops-icons';
import { useAccess } from './staff-access';

type SearchResult = {
  key: string;
  group: string;
  label: string;
  description: string;
  href: string;
};

type SearchState = 'idle' | 'loading' | 'done';

const MIN_QUERY_LENGTH = 3;
const MAX_PER_GROUP = 5;
const SEARCH_PERMISSIONS = [
  'booking.read',
  'trip.read',
  'fleet.read',
  'payment.read',
  'baggage.read',
  'checkin.read',
  'incident.read',
  'passenger.document.read',
] as const;

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase('fr-FR');
}

function matches(query: string, ...values: Array<string | null | undefined>): boolean {
  const needle = normalized(query);
  return values.some((value) => normalized(value).includes(needle));
}

function take(results: SearchResult[]): SearchResult[] {
  return results.slice(0, MAX_PER_GROUP);
}

/**
 * Permission-aware cross-workspace lookup for OPS.
 *
 * The component never broadens authorization: each source is queried only
 * when the STAFF session already holds the corresponding read permission,
 * and the Core API re-authorizes every request.
 */
export function OpsGlobalSearch() {
  const pathname = usePathname();
  const state = useAccess();
  const inputId = useId();
  const resultsId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);

  const permissions = useMemo(
    () => new Set(state.status === 'ready' ? state.access.permissions : []),
    [state],
  );

  useEffect(() => {
    setQuery('');
    setResults([]);
    setOpen(false);
    setSearchState('idle');
  }, [pathname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase('fr-FR') !== 'k' || (!event.metaKey && !event.ctrlKey)) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (state.status !== 'ready' || trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setSearchState('idle');
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      const searches: Array<Promise<SearchResult[]>> = [];
      setSearchState('loading');

      if (permissions.has('booking.read')) {
        searches.push(
          auth.admin.bookings.bookings({ limit: 50 }).then((response) => {
            if (!response.ok) return [];
            return take(
              response.data.items
                .filter((booking) =>
                  matches(
                    trimmed,
                    booking.reference,
                    booking.trip.reference,
                    booking.trip.route.code,
                    booking.trip.route.name,
                  ),
                )
                .map((booking) => ({
                  key: `booking-${booking.id}`,
                  group: 'Réservations',
                  label: booking.reference,
                  description: `${booking.trip.reference} · ${booking.trip.route.code} · ${booking.status}`,
                  href: '/bookings',
                })),
            );
          }),
        );
      }

      if (permissions.has('trip.read')) {
        searches.push(
          auth.admin.trips.trips({ limit: 50 }).then((response) => {
            if (!response.ok) return [];
            return take(
              response.data.items
                .filter((trip) =>
                  matches(
                    trimmed,
                    trip.reference,
                    trip.routeVersion.route.code,
                    trip.routeVersion.route.name,
                    trip.vehicle?.code,
                  ),
                )
                .map((trip) => ({
                  key: `trip-${trip.id}`,
                  group: 'Voyages',
                  label: trip.reference,
                  description: `${trip.routeVersion.route.code} · ${trip.status}${trip.vehicle ? ` · ${trip.vehicle.code}` : ''}`,
                  href: `/trips?fiche=${encodeURIComponent(trip.id)}`,
                })),
            );
          }),
        );
      }

      if (permissions.has('fleet.read')) {
        searches.push(
          auth.admin.fleet.vehicles({ limit: 50 }).then((response) => {
            if (!response.ok) return [];
            return take(
              response.data.items
                .filter((vehicle) =>
                  matches(
                    trimmed,
                    vehicle.code,
                    vehicle.registrationPlate,
                    vehicle.vin,
                    vehicle.manufacturer,
                    vehicle.model,
                  ),
                )
                .map((vehicle) => ({
                  key: `vehicle-${vehicle.id}`,
                  group: 'Flotte',
                  label: vehicle.code,
                  description: `${vehicle.manufacturer} ${vehicle.model} · ${vehicle.registrationPlate ?? 'immatriculation non renseignée'} · ${vehicle.status}`,
                  href: '/fleet',
                })),
            );
          }),
        );
      }

      if (permissions.has('payment.read')) {
        searches.push(
          auth.admin.payments.listPayments({ limit: 50 }).then((response) => {
            if (!response.ok) return [];
            return take(
              response.data.items
                .filter((payment) =>
                  matches(
                    trimmed,
                    payment.reference,
                    payment.booking.reference,
                    payment.providerPaymentId,
                  ),
                )
                .map((payment) => ({
                  key: `payment-${payment.id}`,
                  group: 'Paiements',
                  label: payment.reference,
                  description: `${payment.booking.reference} · ${payment.status}`,
                  href: '/payments',
                })),
            );
          }),
        );
      }

      if (permissions.has('baggage.read')) {
        searches.push(
          auth.admin.baggage.list({ limit: 50 }).then((response) => {
            if (!response.ok) return [];
            return take(
              response.data.items
                .filter((baggage) =>
                  matches(
                    trimmed,
                    baggage.reference,
                    baggage.booking.reference,
                    baggage.booking.trip.reference,
                    baggage.passenger.reference,
                    baggage.passenger.givenName,
                    baggage.passenger.familyName,
                  ),
                )
                .map((baggage) => ({
                  key: `baggage-${baggage.reference}`,
                  group: 'Bagages',
                  label: baggage.reference,
                  description: `${baggage.passenger.givenName} ${baggage.passenger.familyName} · ${baggage.lifecycleStatus}`,
                  href: '/baggage',
                })),
            );
          }),
        );
      }

      if (permissions.has('checkin.read')) {
        searches.push(
          auth.admin.checkIn.list({ limit: 50 }).then((response) => {
            if (!response.ok) return [];
            return take(
              response.data.items
                .filter((item) =>
                  matches(
                    trimmed,
                    item.passenger.reference,
                    item.passenger.givenName,
                    item.passenger.familyName,
                    item.booking.reference,
                    item.trip.reference,
                  ),
                )
                .map((item) => ({
                  key: `passenger-${item.booking.reference}-${item.passenger.reference}`,
                  group: 'Passagers / check-in',
                  label: `${item.passenger.givenName} ${item.passenger.familyName}`,
                  description: `${item.passenger.reference} · ${item.booking.reference} · ${item.trip.reference}`,
                  href: '/check-in',
                })),
            );
          }),
        );
      }

      if (permissions.has('incident.read')) {
        searches.push(
          auth.admin.incidents.list({ limit: 50 }).then((response) => {
            if (!response.ok) return [];
            return take(
              response.data.items
                .filter((incident) =>
                  matches(
                    trimmed,
                    incident.reference,
                    incident.trip.reference,
                    incident.vehicle?.code,
                    incident.baggage?.reference,
                    incident.locationLabel,
                    incident.description,
                  ),
                )
                .map((incident) => ({
                  key: `incident-${incident.id}`,
                  group: 'Incidents',
                  label: incident.reference,
                  description: `${incident.type} · ${incident.severity} · ${incident.status}`,
                  href: '/incidents',
                })),
            );
          }),
        );
      }

      if (permissions.has('passenger.document.read')) {
        searches.push(
          auth.admin.passengerDocuments.list({ limit: 50 }).then((response) => {
            if (!response.ok) return [];
            return take(
              response.data.items
                .filter((document) =>
                  matches(
                    trimmed,
                    document.reference,
                    document.passenger.reference,
                    document.passenger.givenName,
                    document.passenger.familyName,
                    ...document.bookingReferences,
                  ),
                )
                .map((document) => ({
                  key: `document-${document.reference}`,
                  group: 'Documents passagers',
                  label: document.reference,
                  description: `${document.passenger.givenName} ${document.passenger.familyName} · ${document.type} · ${document.status}`,
                  href: '/passenger-documents',
                })),
            );
          }),
        );
      }

      void Promise.all(searches.map((search) => search.catch(() => []))).then((groups) => {
        if (cancelled) return;
        setResults(groups.flat());
        setSearchState('done');
        setOpen(true);
      });
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [permissions, query, state.status]);

  const hasSearchAccess = SEARCH_PERMISSIONS.some((permission) => permissions.has(permission));

  const groups = useMemo(() => {
    const grouped = new Map<string, SearchResult[]>();
    for (const result of results) {
      const current = grouped.get(result.group) ?? [];
      current.push(result);
      grouped.set(result.group, current);
    }
    return [...grouped.entries()];
  }, [results]);

  if (!hasSearchAccess) return null;

  const trimmed = query.trim();
  const showPanel = open && trimmed.length >= MIN_QUERY_LENGTH;

  return (
    <div className="ops-global-search">
      <label className="ops-global-search__label" htmlFor={inputId}>
        Recherche globale
      </label>
      <div className="ops-global-search__control">
        <span aria-hidden="true" className="ops-global-search__icon">
          <OpsIcon name="search" />
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          autoComplete="off"
          placeholder="Rechercher un voyage, une réservation, un client…"
          value={query}
          aria-controls={showPanel ? resultsId : undefined}
          aria-expanded={showPanel}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (trimmed.length >= MIN_QUERY_LENGTH) setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        />
        {query ? (
          <button
            type="button"
            className="ops-global-search__clear"
            aria-label="Effacer la recherche"
            onClick={() => {
              setQuery('');
              setResults([]);
              setOpen(false);
            }}
          >
            ×
          </button>
        ) : (
          <kbd className="ops-global-search__shortcut" aria-hidden="true">
            ⌘ K
          </kbd>
        )}
      </div>

      {showPanel ? (
        <section id={resultsId} className="ops-global-search__panel" aria-label="Résultats globaux">
          {searchState === 'loading' ? (
            <p role="status" className="ops-global-search__status">
              Recherche…
            </p>
          ) : groups.length === 0 ? (
            <p role="status" className="ops-global-search__status">
              Aucun résultat dans les espaces auxquels vous avez accès.
            </p>
          ) : (
            <div className="ops-global-search__groups">
              {groups.map(([group, items], index) => (
                <section
                  key={group}
                  className="ops-global-search__group"
                  aria-labelledby={`${resultsId}-group-${index}`}
                >
                  <h2 id={`${resultsId}-group-${index}`}>{group}</h2>
                  <ul>
                    {items.map((item) => (
                      <li key={item.key}>
                        <Link href={item.href} className="ops-global-search__result">
                          <strong>{item.label}</strong>
                          <span>{item.description}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
