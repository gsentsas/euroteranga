'use client';

import type { BookingSearchStop } from '@euroteranga/auth-client';
import { useEffect, useId, useState } from 'react';
import { auth } from '../lib/auth';
import { stopLabel } from './format';

/** Filterable list of active stops (public, no session). */
export function StopPicker({
  label,
  value,
  known = null,
  onChange,
}: {
  label: string;
  value: string;
  /** The selected stop when it came from elsewhere (a pre-filled link). */
  known?: BookingSearchStop | null;
  onChange: (stopId: string, stop: BookingSearchStop | null) => void;
}) {
  const filterId = useId();
  const selectId = useId();
  const [filter, setFilter] = useState('');
  const [stops, setStops] = useState<BookingSearchStop[]>([]);
  useEffect(() => {
    let current = true;
    const term = filter.trim();
    void auth.booking.public
      .stops(term ? { query: term.slice(0, 64), limit: 50 } : { limit: 50 })
      .then((result) => {
        if (current && result.ok) setStops(result.data.items);
      });
    return () => {
      current = false;
    };
  }, [filter]);
  // A pre-filled stop stays listed even when the current filter hides it.
  const options = known && !stops.some((stop) => stop.id === known.id) ? [known, ...stops] : stops;
  return (
    <fieldset className="et-booking-stop">
      <legend>{label}</legend>
      <div className="et-field">
        <label htmlFor={filterId}>{`Filtrer — ${label.toLowerCase()}`}</label>
        <input
          id={filterId}
          className="et-input"
          type="search"
          autoComplete="off"
          maxLength={64}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="et-field">
        <label htmlFor={selectId}>{label}</label>
        <select
          id={selectId}
          className="et-select"
          required
          value={value}
          onChange={(event) =>
            onChange(
              event.target.value,
              options.find((stop) => stop.id === event.target.value) ?? null,
            )
          }
        >
          <option value="">Choisir un arrêt</option>
          {options.map((stop) => (
            <option key={stop.id} value={stop.id}>
              {stopLabel(stop)}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}
