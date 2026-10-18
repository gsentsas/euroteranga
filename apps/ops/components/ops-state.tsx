import type { ReactNode } from 'react';

export type OpsStateKind = 'loading' | 'empty' | 'error';

export function OpsState({
  kind,
  title,
  detail,
  action,
}: {
  kind: OpsStateKind;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={`ops-state ops-state--${kind}`}
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <span className="ops-state__indicator" aria-hidden="true" />
      <div className="ops-state__content">
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      {action ? <div className="ops-state__action">{action}</div> : null}
    </div>
  );
}
