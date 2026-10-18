'use client';

type BaseProps = {
  title: string;
  description?: string;
};

export function OpsLoadingState({
  title,
  description = 'Les données autorisées sont en cours de récupération.',
}: BaseProps) {
  return (
    <div
      className="ops-data-state ops-data-state--loading"
      role="status"
      aria-live="polite"
      data-testid="ops-loading-state"
    >
      <span className="ops-data-state__spinner" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
    </div>
  );
}

export function OpsEmptyState({ title, description }: BaseProps) {
  return (
    <div className="ops-data-state ops-data-state--empty" data-testid="ops-empty-state">
      <span className="ops-data-state__icon" aria-hidden="true">
        —
      </span>
      <div>
        <strong>{title}</strong>
        {description ? <p>{description}</p> : null}
      </div>
    </div>
  );
}

export function OpsErrorState({
  title,
  message,
  retryLabel = 'Réessayer',
  onRetry,
}: {
  title: string;
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="ops-data-state ops-data-state--error"
      role="alert"
      data-testid="ops-error-state"
    >
      <span className="ops-data-state__icon" aria-hidden="true">
        !
      </span>
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
        {onRetry ? (
          <button type="button" className="et-button et-button--secondary" onClick={onRetry}>
            {retryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
