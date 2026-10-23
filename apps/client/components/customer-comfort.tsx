'use client';

import type {
  ComfortFacility,
  ComfortStep,
  CustomerComfortProjection,
} from '@euroteranga/auth-client';
import { FormAlert } from '@euroteranga/ui';
import { useState } from 'react';
import { auth } from '../lib/auth';

const FACILITY_LABELS: Record<ComfortFacility, string> = {
  RESTROOM: 'Toilettes',
  SHOWER: 'Douches',
  FOOD: 'Restauration',
  SECURE_PARKING: 'Stationnement sécurisé',
  FUEL: 'Ravitaillement',
};

const STATUS_LABELS: Record<ComfortStep['status'], string> = {
  PLANNED: 'Prévu',
  CONFIRMED: 'Confirmé',
  COMPLETED: 'Effectué',
  CANCELLED: 'Annulé',
  SKIPPED: 'Non effectué',
};

const formatAt = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : '—';

function StepSummary({
  title,
  step,
}: {
  title: string;
  step: ComfortStep | null;
}) {
  if (!step) {
    return (
      <div className="et-comfort-step">
        <strong>{title}</strong>
        <span>—</span>
      </div>
    );
  }

  const facilities =
    step.status === 'COMPLETED' && step.actualFacilities.length > 0
      ? step.actualFacilities
      : step.plannedFacilities;
  const facilityPrefix =
    step.status === 'COMPLETED' && step.actualFacilities.length > 0
      ? 'Services constatés'
      : 'Services prévus';

  return (
    <div className="et-comfort-step">
      <div className="et-actions">
        <strong>{title}</strong>
        <span className="et-tag">{STATUS_LABELS[step.status]}</span>
      </div>
      <span>
        {step.name} — {step.locality}
      </span>
      <span>
        Arrivée indicative : {formatAt(step.plannedArrivalAt)}
      </span>
      {step.suggestedDwellMinutes ? (
        <span>Pause indicative : {step.suggestedDwellMinutes} min</span>
      ) : null}
      {facilities.length > 0 ? (
        <span>
          {facilityPrefix} : {facilities.map((facility) => FACILITY_LABELS[facility]).join(', ')}
        </span>
      ) : null}
    </div>
  );
}

export function CustomerComfort({ bookingReference }: { bookingReference: string }) {
  const [data, setData] = useState<CustomerComfortProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await auth.booking.customer.comfort(bookingReference);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setData(result.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="et-comfort-summary"
      data-testid={`customer-comfort-${bookingReference}`}
    >
      <div className="et-actions">
        <div>
          <h4>Suivi du voyage</h4>
          <p>Étapes et pauses communiquées par EURO TERANGA.</p>
        </div>
        <button
          type="button"
          className="et-button et-button--secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          {data ? 'Actualiser le suivi' : 'Afficher le suivi'}
        </button>
      </div>
      <FormAlert message={error} />
      {busy && !data ? <p role="status">Chargement du suivi…</p> : null}
      {data ? (
        <>
          <div className="et-comfort-grid">
            <StepSummary title="Dernière étape connue" step={data.currentStep} />
            <StepSummary title="Prochaine étape" step={data.nextStep} />
            <StepSummary title="Prochaine pause" step={data.nextPause} />
          </div>
          <p className="et-comfort-note">
            Les horaires, pauses et services prévus restent indicatifs jusqu’à leur confirmation
            opérationnelle.
          </p>
        </>
      ) : null}
    </div>
  );
}
