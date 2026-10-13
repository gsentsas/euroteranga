'use client';

import type { ApiResult } from '@euroteranga/auth-client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { useAdminFeedback } from '../admin/admin-feedback';
import type { PublishedVersionOption } from './use-published-versions';

type Run = ReturnType<typeof useAdminFeedback>['run'];

/**
 * Choose a currently PUBLISHED seat-map version (or none). The current value
 * is sent as the expected state so that a decision made on a stale screen is
 * refused by the API.
 */
export function SeatMapAssignmentForm({
  formLabel,
  selectLabel,
  submitLabel,
  currentId,
  currentLabel,
  options,
  run,
  busy,
  success,
  assign,
  onSaved,
}: {
  formLabel: string;
  selectLabel: string;
  submitLabel: string;
  currentId: string | null;
  currentLabel: string;
  options: readonly PublishedVersionOption[];
  run: Run;
  busy: boolean;
  success: (label: string) => string;
  assign: (seatMapVersionId: string | null, expected: string | null) => Promise<ApiResult<unknown>>;
  onSaved: () => Promise<void>;
}) {
  const selectId = useId();
  const [value, setValue] = useState('');
  useEffect(() => {
    setValue(currentId ?? '');
  }, [currentId]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next = value || null;
    const label = next
      ? (options.find((option) => option.id === next)?.label ?? currentLabel)
      : 'aucun';
    const ok = await run(() => assign(next, currentId), success(label));
    if (ok) await onSaved();
  };
  return (
    <form className="et-form et-network-form" aria-label={formLabel} onSubmit={submit}>
      <div className="et-field">
        <label htmlFor={selectId}>{selectLabel}</label>
        <select
          id={selectId}
          className="et-select"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="">Aucun plan</option>
          {currentId && !options.some((option) => option.id === currentId) ? (
            <option value={currentId}>{`${currentLabel} (actuel)`}</option>
          ) : null}
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="et-hint">Seules les versions publiées des plans actifs sont proposées.</p>
      </div>
      <button className="et-button" type="submit" disabled={busy}>
        {submitLabel}
      </button>
    </form>
  );
}
