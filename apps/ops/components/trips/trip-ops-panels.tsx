'use client';

import type { AdminTrip } from '@euroteranga/auth-client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  allowanceLabel,
  EXCEPTION_LABELS as BAGGAGE_EXCEPTION_LABELS,
  EXCEPTION_TONES as BAGGAGE_EXCEPTION_TONES,
  LIFECYCLE_LABELS as BAGGAGE_LIFECYCLE_LABELS,
  LIFECYCLE_TONES as BAGGAGE_LIFECYCLE_TONES,
  TYPE_LABELS as BAGGAGE_TYPE_LABELS,
} from '../baggage/baggage-admin';
import {
  bookingStatusTone,
  STATUS_LABELS as BOOKING_STATUS_LABELS,
} from '../bookings/bookings-admin';
import {
  DIRECTION_LABELS as CARGO_DIRECTION_LABELS,
  EXCEPTION_LABELS as CARGO_EXCEPTION_LABELS,
  EXCEPTION_TONES as CARGO_EXCEPTION_TONES,
  STATUS_LABELS as CARGO_STATUS_LABELS,
  STATUS_TONES as CARGO_STATUS_TONES,
} from '../cargo/cargo-admin';
import { OpsEmptyState, OpsErrorState, OpsLoadingState } from '../ops-data-state';
import { OpsStatusBadge } from '../ops-ui';
import type { CockpitPermissions, CockpitSource, TripCockpitData } from './trip-cockpit-data';
import { bookingFigures } from './trip-overview';
import { formatCargoVolume, formatKg, formatMinor, formatUtc } from './trip-format';
import { tripPageHref } from './trip-link';

function PanelHead({
  title,
  titleId,
  children,
}: {
  title: string;
  titleId: string;
  children?: ReactNode;
}) {
  return (
    <div className="ops-trip-section-head">
      <h3 id={titleId}>{title}</h3>
      {children ? <div className="ops-trip-section-head__actions">{children}</div> : null}
    </div>
  );
}

/** Loading / error / partial states shared by the list tabs. */
function SourceGate<T>({
  source,
  label,
  onRetry,
  children,
}: {
  source: CockpitSource<T>;
  label: string;
  onRetry: () => void;
  children: (data: T, partial: boolean) => ReactNode;
}) {
  if (source.state === 'off' || source.state === 'idle') return null;
  if (source.state === 'loading') return <OpsLoadingState title={`Chargement — ${label}`} />;
  if (source.state === 'error') {
    return (
      <OpsErrorState
        title={`Impossible de charger : ${label}`}
        message={source.error}
        onRetry={onRetry}
      />
    );
  }
  return (
    <>
      {children(source.data, source.partial)}
      {source.partial ? (
        <p className="et-hint">
          Liste partielle : seules les premières pages sont affichées ; la page dédiée donne la
          liste complète.
        </p>
      ) : null}
    </>
  );
}

function Summary({ items }: { items: ReadonlyArray<[string, ReactNode]> }) {
  return (
    <dl className="ops-trip-summary">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PassengersPanel({
  trip,
  data,
  can,
  onRetry,
}: {
  trip: AdminTrip;
  data: TripCockpitData;
  can: CockpitPermissions;
  onRetry: () => void;
}) {
  const readiness = data.readiness.state === 'ready' ? data.readiness.data.readiness : null;
  return (
    <section aria-labelledby="trip-passengers-title">
      <div className="ops-trip-section-head">
        <h3 id="trip-passengers-title">Passagers et réservations</h3>
        <div className="ops-trip-section-head__actions">
          {can.checkIn ? (
            <Link
              className="et-button et-button--secondary"
              href={tripPageHref('/check-in', trip.reference)}
            >
              Ouvrir le check-in
            </Link>
          ) : null}
          <Link className="et-button et-button--secondary" href="/bookings">
            Toutes les réservations
          </Link>
        </div>
      </div>
      <SourceGate source={data.bookings} label="réservations du voyage" onRetry={onRetry}>
        {(bookings) => {
          const figures = bookingFigures(bookings);
          const capacity = trip.seatMapVersion?.seatCount ?? null;
          return (
            <>
              <Summary
                items={[
                  [
                    'Places payées',
                    capacity !== null ? `${figures.confirmed} / ${capacity}` : figures.confirmed,
                  ],
                  ['Places retenues', figures.held],
                  ['Réservations', bookings.length],
                  ...(readiness
                    ? ([
                        [
                          'Enregistrés',
                          `${readiness.passengers.checkedIn} / ${readiness.passengers.total}`,
                        ],
                        [
                          'Embarqués',
                          `${readiness.passengers.boarded} / ${readiness.passengers.total}`,
                        ],
                      ] as Array<[string, ReactNode]>)
                    : []),
                ]}
              />
              {bookings.length === 0 ? (
                <OpsEmptyState
                  title="Aucune réservation"
                  description="Aucune réservation n’est enregistrée sur ce voyage."
                />
              ) : (
                <div className="et-table-wrap">
                  <table className="et-table">
                    <caption>{`Réservations du voyage ${trip.reference}`}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Réservation</th>
                        <th scope="col">Statut</th>
                        <th scope="col">Trajet</th>
                        <th scope="col">Places</th>
                        <th scope="col">Montant</th>
                        <th scope="col">Créée le</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bookings.map((booking) => (
                        <tr key={booking.id}>
                          <th scope="row">
                            <span className="et-code">{booking.reference}</span>
                          </th>
                          <td>
                            <OpsStatusBadge tone={bookingStatusTone(booking.status)}>
                              {BOOKING_STATUS_LABELS[booking.status]}
                            </OpsStatusBadge>
                          </td>
                          <td>
                            {booking.origin.stop?.code ?? '—'} →{' '}
                            {booking.destination.stop?.code ?? '—'}
                          </td>
                          <td>
                            {booking.seats
                              .filter((seat) => !seat.releasedAt)
                              .map((seat) => seat.seatLabel ?? '—')
                              .join(', ') || booking.seatCount}
                          </td>
                          <td>
                            {formatMinor(
                              booking.totalAmountMinor,
                              booking.currencyCode,
                              booking.currencyMinorUnit,
                            )}
                          </td>
                          <td>{formatUtc(booking.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        }}
      </SourceGate>
    </section>
  );
}

export function BaggagePanel({
  trip,
  data,
  onRetry,
}: {
  trip: AdminTrip;
  data: TripCockpitData;
  onRetry: () => void;
}) {
  return (
    <section aria-labelledby="trip-baggage-title">
      <div className="ops-trip-section-head">
        <h3 id="trip-baggage-title">Bagages</h3>
        <div className="ops-trip-section-head__actions">
          <Link className="et-button et-button--secondary" href="/baggage">
            Ouvrir les bagages
          </Link>
        </div>
      </div>
      <SourceGate source={data.baggage} label="bagages du voyage" onRetry={onRetry}>
        {(items) => {
          const kept = items.filter((item) => item.lifecycleStatus !== 'REMOVED');
          const weighed = kept.filter((item) => item.measuredWeightKg !== null);
          const totalKg = weighed.reduce((total, item) => total + Number(item.measuredWeightKg), 0);
          const incidents = kept.filter((item) => item.exceptionStatus !== null).length;
          return (
            <>
              <Summary
                items={[
                  ['Bagages', kept.length],
                  ['Poids pesé', formatKg(totalKg)],
                  ['Non pesés', kept.length - weighed.length],
                  ['Incidents', incidents],
                ]}
              />
              {items.length === 0 ? (
                <OpsEmptyState
                  title="Aucun bagage"
                  description="Aucun bagage n’est enregistré sur ce voyage."
                />
              ) : (
                <div className="et-table-wrap">
                  <table className="et-table">
                    <caption>{`Bagages du voyage ${trip.reference}`}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Bagage</th>
                        <th scope="col">Passager</th>
                        <th scope="col">Type</th>
                        <th scope="col">Statut</th>
                        <th scope="col">Poids</th>
                        <th scope="col">Franchise</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.reference}>
                          <th scope="row">
                            <span className="et-code">{item.reference}</span>
                          </th>
                          <td>
                            {item.passenger.givenName} {item.passenger.familyName}
                          </td>
                          <td>{BAGGAGE_TYPE_LABELS[item.type]}</td>
                          <td>
                            <OpsStatusBadge tone={BAGGAGE_LIFECYCLE_TONES[item.lifecycleStatus]}>
                              {BAGGAGE_LIFECYCLE_LABELS[item.lifecycleStatus]}
                            </OpsStatusBadge>
                            {item.exceptionStatus ? (
                              <OpsStatusBadge tone={BAGGAGE_EXCEPTION_TONES[item.exceptionStatus]}>
                                {BAGGAGE_EXCEPTION_LABELS[item.exceptionStatus]}
                              </OpsStatusBadge>
                            ) : null}
                          </td>
                          <td>
                            {item.measuredWeightKg !== null
                              ? formatKg(item.measuredWeightKg)
                              : 'Non pesé'}
                          </td>
                          <td>{allowanceLabel(item)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        }}
      </SourceGate>
    </section>
  );
}

export function CargoPanel({
  trip,
  data,
  onRetry,
}: {
  trip: AdminTrip;
  data: TripCockpitData;
  onRetry: () => void;
}) {
  const capacity = data.profit.state === 'ready' ? data.profit.data.cargo.capacity : null;
  return (
    <section aria-labelledby="trip-cargo-title">
      <div className="ops-trip-section-head">
        <h3 id="trip-cargo-title">Colis & fret</h3>
        <div className="ops-trip-section-head__actions">
          <Link className="et-button et-button--secondary" href="/cargo">
            Ouvrir les colis et le fret
          </Link>
        </div>
      </div>
      <SourceGate source={data.cargo} label="colis et fret du voyage" onRetry={onRetry}>
        {(items) => {
          const live = items.filter(
            (item) => item.lifecycleStatus !== 'CANCELLED' && item.lifecycleStatus !== 'REFUSED',
          );
          const totalKg = live.reduce((total, item) => total + Number(item.weightKg), 0);
          const totalLiters = live.reduce((total, item) => total + item.volumeLiters, 0);
          const packages = live.reduce((total, item) => total + item.packageCount, 0);
          return (
            <>
              <Summary
                items={[
                  ['Envois actifs', live.length],
                  ['Colis', packages],
                  ['Poids', formatKg(totalKg)],
                  ['Volume', formatCargoVolume(totalLiters)],
                  ...(capacity && capacity.vehicleCount > 0
                    ? ([
                        [
                          'Occupation du convoi (Finance)',
                          `${formatKg(capacity.usedWeightKg)} / ${formatKg(capacity.payloadCapacityKg)}`,
                        ],
                      ] as Array<[string, ReactNode]>)
                    : []),
                ]}
              />
              {items.length === 0 ? (
                <OpsEmptyState
                  title="Aucun envoi"
                  description="Aucun colis ni fret n’est affecté à ce voyage."
                />
              ) : (
                <div className="et-table-wrap">
                  <table className="et-table">
                    <caption>{`Colis et fret du voyage ${trip.reference}`}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Envoi</th>
                        <th scope="col">Sens</th>
                        <th scope="col">Statut</th>
                        <th scope="col">Colis</th>
                        <th scope="col">Poids</th>
                        <th scope="col">Volume</th>
                        <th scope="col">Véhicule</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.reference}>
                          <th scope="row">
                            <span className="et-code">{item.reference}</span>
                          </th>
                          <td>{CARGO_DIRECTION_LABELS[item.direction]}</td>
                          <td>
                            <OpsStatusBadge tone={CARGO_STATUS_TONES[item.lifecycleStatus]}>
                              {CARGO_STATUS_LABELS[item.lifecycleStatus]}
                            </OpsStatusBadge>
                            {item.exceptionStatus ? (
                              <OpsStatusBadge tone={CARGO_EXCEPTION_TONES[item.exceptionStatus]}>
                                {CARGO_EXCEPTION_LABELS[item.exceptionStatus]}
                              </OpsStatusBadge>
                            ) : null}
                          </td>
                          <td>{item.packageCount}</td>
                          <td>{formatKg(item.weightKg)}</td>
                          <td>{formatCargoVolume(item.volumeLiters)}</td>
                          <td>{item.vehicle?.code ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        }}
      </SourceGate>
    </section>
  );
}

export function DocumentsPanel({
  trip,
  data,
  onRetry,
}: {
  trip: AdminTrip;
  data: TripCockpitData;
  onRetry: () => void;
}) {
  return (
    <section aria-labelledby="trip-documents-title">
      <PanelHead title="Documents du voyage" titleId="trip-documents-title">
        <Link
          className="et-button et-button--secondary"
          href={tripPageHref('/manifests', trip.reference)}
        >
          Ouvrir les manifestes
        </Link>
      </PanelHead>
      <p className="et-hint">Manifestes passagers générés pour ce voyage (versions immuables).</p>
      <SourceGate source={data.manifests} label="manifestes du voyage" onRetry={onRetry}>
        {(manifests) =>
          manifests.length === 0 ? (
            <OpsEmptyState
              title="Aucun manifeste"
              description="Aucun manifeste passagers n’a encore été généré pour ce voyage."
            />
          ) : (
            <div className="et-table-wrap">
              <table className="et-table">
                <caption>{`Manifestes du voyage ${trip.reference}`}</caption>
                <thead>
                  <tr>
                    <th scope="col">Manifeste</th>
                    <th scope="col">Version</th>
                    <th scope="col">Généré le</th>
                    <th scope="col">Passagers</th>
                    <th scope="col">Embarqués</th>
                  </tr>
                </thead>
                <tbody>
                  {manifests.map((manifest) => (
                    <tr key={manifest.reference}>
                      <th scope="row">
                        <span className="et-code">{manifest.reference}</span>
                      </th>
                      <td>v{manifest.version}</td>
                      <td>{formatUtc(manifest.generatedAt)}</td>
                      <td>{manifest.passengerCount}</td>
                      <td>{manifest.boardedCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </SourceGate>
    </section>
  );
}
