'use client';

import {
  type CustomerBooking,
  type Passenger,
  type PassengerCountry,
  type PassengerDocument,
  type PassengerDocumentStatus,
  type PassengerDocumentType,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { auth } from '../lib/auth';

const DOCUMENT_LABELS: Record<PassengerDocumentType, string> = {
  PASSPORT: 'Passeport',
  NATIONAL_ID: 'Carte nationale d’identité',
  RESIDENCE_PERMIT: 'Titre de séjour',
  VISA: 'Visa',
  PARENTAL_AUTHORIZATION: 'Autorisation parentale',
  OTHER: 'Autre',
};

const STATUS_LABELS: Record<PassengerDocumentStatus, string> = {
  QUARANTINED: 'Analyse de sécurité en cours',
  ACCEPTED: 'Fichier accepté techniquement',
  REJECTED: 'Fichier refusé',
};

interface PassengerWithDocuments {
  passenger: Passenger;
  documents: PassengerDocument[];
}

/** CUSTOMER UI; every ownership and capacity decision is repeated by the API. */
export function CustomerPassengers() {
  const router = useRouter();
  const [bookings, setBookings] = useState<CustomerBooking[]>([]);
  const [countries, setCountries] = useState<PassengerCountry[]>([]);
  const [rows, setRows] = useState<PassengerWithDocuments[] | null>(null);
  const [bookingReference, setBookingReference] = useState('');
  const [givenName, setGivenName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [nationalityCountryId, setNationalityCountryId] = useState('');
  const [uploadPassenger, setUploadPassenger] = useState('');
  const [documentType, setDocumentType] = useState<PassengerDocumentType>('PASSPORT');
  const [expiresAt, setExpiresAt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<'create' | 'upload' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [bookingResult, countryResult] = await Promise.all([
      auth.booking.customer.bookings({ limit: 50 }),
      auth.booking.customer.passengerCountries(),
    ]);
    if (!bookingResult.ok) {
      if (bookingResult.error.status === 401) router.replace('/connexion');
      else setError(bookingResult.error.message);
      return;
    }
    if (!countryResult.ok) {
      setError(countryResult.error.message);
      return;
    }
    const confirmed = bookingResult.data.items.filter((booking) => booking.status === 'CONFIRMED');
    setBookings(confirmed);
    setCountries(countryResult.data.items);
    setBookingReference((current) => current || confirmed[0]?.reference || '');
    setNationalityCountryId((current) => current || countryResult.data.items[0]?.id || '');

    const passengerResults = await Promise.all(
      confirmed.map((booking) => auth.booking.customer.passengers(booking.reference)),
    );
    const passengers = passengerResults.flatMap((result) => (result.ok ? result.data.items : []));
    const unique = [
      ...new Map(passengers.map((passenger) => [passenger.reference, passenger])).values(),
    ];
    const documents = await Promise.all(
      unique.map(async (passenger) => {
        const result = await auth.booking.customer.documents(passenger.reference);
        return { passenger, documents: result.ok ? result.data.items : [] };
      }),
    );
    setRows(documents);
    setUploadPassenger((current) => current || unique[0]?.reference || '');
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const passengerOptions = useMemo(() => rows?.map(({ passenger }) => passenger) ?? [], [rows]);

  const createPassenger = async (event: FormEvent) => {
    event.preventDefault();
    if (!bookingReference || !nationalityCountryId || busy) return;
    setBusy('create');
    setError(null);
    setNotice(null);
    try {
      const result = await auth.booking.customer.createPassenger(bookingReference, {
        givenName,
        familyName,
        dateOfBirth,
        nationalityCountryId,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setGivenName('');
      setFamilyName('');
      setDateOfBirth('');
      setUploadPassenger(result.data.reference);
      await load();
      setNotice(`Voyageur ${result.data.givenName} ${result.data.familyName} ajouté.`);
    } finally {
      setBusy(null);
    }
  };

  const upload = async (event: FormEvent) => {
    event.preventDefault();
    if (!uploadPassenger || !file || busy) return;
    setBusy('upload');
    setError(null);
    setNotice('Téléversement terminé. Analyse de sécurité en cours…');
    try {
      const result = await auth.booking.customer.uploadDocument(uploadPassenger, {
        type: documentType,
        file,
        ...(expiresAt ? { expiresAt } : {}),
      });
      if (!result.ok) {
        setNotice(null);
        setError(result.error.message);
        await load();
        return;
      }
      setFile(null);
      setExpiresAt('');
      const input = document.querySelector<HTMLInputElement>('#passenger-document-file');
      if (input) input.value = '';
      await load();
      setNotice(`Document ${result.data.reference} accepté techniquement.`);
    } finally {
      setBusy(null);
    }
  };

  const download = async (reference: string) => {
    if (busy) return;
    setBusy('download');
    setError(null);
    try {
      const result = await auth.booking.customer.downloadDocument(reference);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const url = URL.createObjectURL(result.data.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.data.filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="customer-passengers-title" data-testid="customer-passengers">
      <div className="et-actions">
        <h2 id="customer-passengers-title">Voyageurs et documents</h2>
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void load()}
        >
          Actualiser
        </button>
      </div>
      <p>
        Le compte client est le réservant ; chaque voyageur est une personne distincte. Un fichier «
        accepté techniquement » a passé les contrôles de sécurité, sans valider sa conformité au
        voyage.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      {bookings.length === 0 ? (
        <p>Une réservation confirmée est nécessaire avant d’ajouter ses voyageurs.</p>
      ) : (
        <form className="et-form et-passenger-form" onSubmit={createPassenger}>
          <h3>Ajouter un voyageur</h3>
          <label>
            Réservation confirmée
            <select
              value={bookingReference}
              onChange={(event) => setBookingReference(event.target.value)}
            >
              {bookings.map((booking) => (
                <option key={booking.reference} value={booking.reference}>
                  {booking.reference} · {booking.trip.reference}
                </option>
              ))}
            </select>
          </label>
          <label>
            Prénom
            <input
              required
              maxLength={100}
              value={givenName}
              onChange={(event) => setGivenName(event.target.value)}
            />
          </label>
          <label>
            Nom
            <input
              required
              maxLength={100}
              value={familyName}
              onChange={(event) => setFamilyName(event.target.value)}
            />
          </label>
          <label>
            Date de naissance
            <input
              required
              type="date"
              max={new Date().toISOString().slice(0, 10)}
              value={dateOfBirth}
              onChange={(event) => setDateOfBirth(event.target.value)}
            />
          </label>
          <label>
            Nationalité
            <select
              required
              value={nationalityCountryId}
              onChange={(event) => setNationalityCountryId(event.target.value)}
            >
              {countries.map((country) => (
                <option key={country.id} value={country.id}>
                  {country.name} ({country.iso2})
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="et-button" disabled={busy !== null}>
            Ajouter le voyageur
          </button>
        </form>
      )}

      {!rows ? <p role="status">Chargement des voyageurs…</p> : null}
      {rows?.length === 0 ? <p>Aucun voyageur enregistré.</p> : null}
      {rows ? (
        <div className="et-passenger-list">
          {rows.map(({ passenger, documents }) => (
            <article key={passenger.reference} className="et-customer-booking">
              <div className="et-actions">
                <h3>
                  {passenger.givenName} {passenger.familyName}
                </h3>
                <span className="et-code">{passenger.reference}</span>
              </div>
              <p>
                Né(e) le {passenger.dateOfBirth} · Nationalité {passenger.nationality.name} ·
                Réservation(s) {passenger.bookingReferences.join(', ')}
              </p>
              <h4>Documents</h4>
              {documents.length === 0 ? (
                <p>Non fourni.</p>
              ) : (
                <ul className="et-document-list">
                  {documents.map((item) => (
                    <li key={item.reference}>
                      <span>
                        {DOCUMENT_LABELS[item.type]} · {item.reference}
                      </span>{' '}
                      <span className="et-tag">{STATUS_LABELS[item.status]}</span>{' '}
                      {item.status === 'ACCEPTED' ? (
                        <button
                          type="button"
                          className="et-button et-button--secondary"
                          disabled={busy !== null}
                          onClick={() => void download(item.reference)}
                        >
                          Télécharger
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      ) : null}

      {passengerOptions.length ? (
        <form className="et-form et-passenger-form" onSubmit={upload}>
          <h3>Ajouter un document</h3>
          <label>
            Voyageur
            <select
              value={uploadPassenger}
              onChange={(event) => setUploadPassenger(event.target.value)}
            >
              {passengerOptions.map((passenger) => (
                <option key={passenger.reference} value={passenger.reference}>
                  {passenger.givenName} {passenger.familyName} · {passenger.reference}
                </option>
              ))}
            </select>
          </label>
          <label>
            Type de document
            <select
              value={documentType}
              onChange={(event) => setDocumentType(event.target.value as PassengerDocumentType)}
            >
              {(Object.keys(DOCUMENT_LABELS) as PassengerDocumentType[]).map((type) => (
                <option key={type} value={type}>
                  {DOCUMENT_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Date d’expiration (facultative, sans validation réglementaire)
            <input
              type="date"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>
          <label>
            Fichier PDF, JPEG ou PNG — 10 Mio maximum
            <input
              id="passenger-document-file"
              required
              type="file"
              accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <button type="submit" className="et-button" disabled={busy !== null || !file}>
            {busy === 'upload' ? 'Analyse de sécurité…' : 'Téléverser et analyser'}
          </button>
        </form>
      ) : null}
    </section>
  );
}
