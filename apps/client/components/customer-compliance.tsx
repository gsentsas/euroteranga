'use client';

import type {
  ComplianceStatus,
  CustomerBookingCompliance,
  CustomerPassengerCompliance,
  PassengerDocumentType,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { auth } from '../lib/auth';

/** Customer wording: never a legal or travel authorization on its own. */
export const COMPLIANCE_STATUS_LABELS: Record<ComplianceStatus, string> = {
  NOT_EVALUATED: 'À vérifier',
  STALE: 'À vérifier : informations ou règles modifiées depuis la dernière vérification',
  REVIEW_REQUIRED: 'Revue en cours',
  COMPLIANT_BY_RULES: 'Conforme selon les règles publiées',
  NON_COMPLIANT_BY_RULES: 'Non conforme selon les règles publiées',
  COMPLIANT: 'Conforme après revue',
  NON_COMPLIANT: 'Non conforme après revue',
  NEEDS_INFORMATION: 'Informations complémentaires requises',
};

const DOCUMENT_LABELS: Record<PassengerDocumentType, string> = {
  PASSPORT: 'Passeport',
  NATIONAL_ID: 'Carte nationale d’identité',
  RESIDENCE_PERMIT: 'Titre de séjour',
  VISA: 'Visa',
  PARENTAL_AUTHORIZATION: 'Autorisation parentale',
  OTHER: 'Autre document',
};

function findingText(code: string, documentType?: PassengerDocumentType | null, country?: string) {
  const document = documentType ? DOCUMENT_LABELS[documentType] : 'Document';
  switch (code) {
    case 'NO_APPLICABLE_RULE':
      return 'Aucune règle publiée et vérifiée ne s’applique encore à ce voyage : une revue humaine est nécessaire.';
    case 'NO_VERIFIED_COVERAGE':
      return `Aucune règle vérifiée ne couvre encore le pays ${country ?? ''} : une revue humaine est nécessaire.`;
    case 'DOCUMENT_MISSING':
      return `${document} requis.`;
    case 'DOCUMENT_VALIDITY_TOO_SHORT':
      return `${document} : validité insuffisante pour ce voyage.`;
    case 'DOCUMENT_EXPIRY_UNKNOWN':
      return `${document} : date d’expiration à renseigner ou à vérifier.`;
    case 'DOCUMENT_REQUIRES_HUMAN_CHECK':
      return `${document} : vérification humaine nécessaire.`;
    case 'HUMAN_REVIEW_REQUIRED':
      return 'Vérification humaine nécessaire.';
    default:
      return 'Vérification nécessaire.';
  }
}

function PassengerCompliance({
  bookingReference,
  item,
  busy,
  onEvaluate,
}: {
  bookingReference: string;
  item: CustomerPassengerCompliance;
  busy: boolean;
  onEvaluate: (bookingReference: string, passengerReference: string) => void;
}) {
  return (
    <article className="et-customer-booking" data-testid={`compliance-${item.passenger.reference}`}>
      <div className="et-actions">
        <h4>
          {item.passenger.givenName} {item.passenger.familyName}
        </h4>
        <span className="et-tag">{COMPLIANCE_STATUS_LABELS[item.status]}</span>
      </div>
      {item.evaluation ? (
        <p>
          Vérifiée le {new Date(item.evaluation.evaluatedAt).toLocaleString('fr-FR')} pour un départ
          le {item.evaluation.travelDate}
          {item.evaluation.current ? '.' : ' : cette vérification n’est plus à jour.'}
        </p>
      ) : (
        <p>La conformité de ce voyageur n’a pas encore été vérifiée.</p>
      )}
      {item.review?.customerMessage ? (
        <p>Message de l’équipe : {item.review.customerMessage}</p>
      ) : null}
      {item.requirements.length > 0 || item.findings.length > 0 ? (
        <ul className="et-document-list">
          {item.requirements.map((requirement, index) => (
            <li key={`requirement-${index}`}>
              <span>{requirement.guidance}</span>
              {requirement.findings.map((finding, findingIndex) => (
                <span key={findingIndex} className="et-tag">
                  {findingText(finding.code, finding.documentType)}
                </span>
              ))}
            </li>
          ))}
          {item.findings.map((finding, index) => (
            <li key={`finding-${index}`}>
              {findingText(finding.code, finding.documentType, finding.country)}
            </li>
          ))}
        </ul>
      ) : null}
      {item.documents.length > 0 ? (
        <p>
          Documents examinés :{' '}
          {item.documents
            .map((document) => `${DOCUMENT_LABELS[document.type]} (${document.reference})`)
            .join(', ')}
        </p>
      ) : null}
      <button
        type="button"
        className="et-button et-button--secondary"
        disabled={busy}
        onClick={() => onEvaluate(bookingReference, item.passenger.reference)}
      >
        Vérifier la conformité
      </button>
    </article>
  );
}

/**
 * CUSTOMER compliance summary of confirmed bookings. The API derives every
 * fact and decides every status; this view only explains it.
 */
export function CustomerCompliance() {
  const router = useRouter();
  const [bookings, setBookings] = useState<CustomerBookingCompliance[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const result = await auth.booking.customer.bookings({ limit: 50 });
    if (!result.ok) {
      if (result.error.status === 401) router.replace('/connexion');
      else setError(result.error.message);
      return;
    }
    const confirmed = result.data.items.filter((booking) => booking.status === 'CONFIRMED');
    const summaries = await Promise.all(
      confirmed.map((booking) => auth.booking.customer.compliance(booking.reference)),
    );
    setBookings(summaries.flatMap((summary) => (summary.ok ? [summary.data] : [])));
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const evaluate = async (bookingReference: string, passengerReference: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await auth.booking.customer.evaluateCompliance(
        bookingReference,
        passengerReference,
      );
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNotice(`Vérification terminée : ${COMPLIANCE_STATUS_LABELS[result.data.status]}.`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="customer-compliance-title" data-testid="customer-compliance">
      <div className="et-actions">
        <h2 id="customer-compliance-title">Conformité du voyage</h2>
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void load()}
        >
          Actualiser
        </button>
      </div>
      <p>
        « Fichier accepté techniquement » signifie seulement que le fichier a passé les contrôles de
        sécurité : ce n’est pas un « document réglementaire validé ». La conformité est vérifiée
        selon des règles publiées à partir de sources officielles vérifiées et, si nécessaire, par
        une revue humaine. En l’absence de règle vérifiée, le dossier reste à vérifier.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      {!bookings ? <p role="status">Chargement de la conformité…</p> : null}
      {bookings?.every((booking) => booking.items.length === 0) ? (
        <p>Ajoutez des voyageurs à une réservation confirmée pour vérifier leur conformité.</p>
      ) : null}
      {bookings?.map((booking) =>
        booking.items.length === 0 ? null : (
          <div key={booking.bookingReference} className="et-passenger-list">
            <h3>Réservation {booking.bookingReference}</h3>
            {booking.items.map((item) => (
              <PassengerCompliance
                key={item.passenger.reference}
                bookingReference={booking.bookingReference}
                item={item}
                busy={busy}
                onEvaluate={(bookingReference, passengerReference) =>
                  void evaluate(bookingReference, passengerReference)
                }
              />
            ))}
          </div>
        ),
      )}
    </section>
  );
}
