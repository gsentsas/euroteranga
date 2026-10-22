'use client';

import type { AdminVehicleDetail, VehicleMediaKind } from '@euroteranga/auth-client';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import type { useAdminFeedback } from '../admin/admin-feedback';
import { MediaPicker } from '../media/media-picker';

type Run = ReturnType<typeof useAdminFeedback>['run'];

const KIND_OPTIONS: Array<[VehicleMediaKind, string]> = [
  ['EXTERIOR', 'Extérieur'],
  ['INTERIOR', 'Intérieur'],
  ['SEATS', 'Sièges'],
  ['LUGGAGE_HOLD', 'Soute'],
  ['EQUIPMENT', 'Équipements'],
  ['CABIN', 'Cabine'],
  ['OTHER', 'Autre'],
];

interface GalleryDraft {
  key: string;
  mediaId: string | null;
  kind: VehicleMediaKind | null;
}

/** MEDIA-1 selector for a vehicle's main image and ordered public gallery. */
export function VehicleMediaForm({
  vehicle,
  canManage,
  run,
  busy,
  onSaved,
}: {
  vehicle: AdminVehicleDetail;
  /** fleet.manage + media.read; media.manage is deliberately not needed. */
  canManage: boolean;
  run: Run;
  busy: boolean;
  onSaved: () => Promise<void>;
}) {
  const id = useId();
  const nextKey = useRef(0);
  const [primaryMediaId, setPrimaryMediaId] = useState<string | null>(null);
  const [gallery, setGallery] = useState<GalleryDraft[]>([]);
  useEffect(() => {
    setPrimaryMediaId(vehicle.primaryMedia?.id ?? null);
    setGallery(
      vehicle.mediaGallery.map((item) => ({
        key: item.id,
        mediaId: item.mediaId,
        kind: item.kind,
      })),
    );
  }, [vehicle]);

  const readOnly = !canManage || vehicle.status === 'RETIRED';
  const Wrapper = readOnly ? 'section' : 'form';
  const incomplete = gallery.some((item) => !item.mediaId);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || busy || incomplete) return;
    const ok = await run(
      () =>
        auth.admin.fleet.assignVehicleMedia(vehicle.id, {
          primaryMediaId,
          gallery: gallery.map((item) => ({ mediaId: item.mediaId!, kind: item.kind })),
        }),
      `Médias du véhicule ${vehicle.code} enregistrés.`,
    );
    if (ok) await onSaved();
  };
  const update = (index: number, value: Partial<GalleryDraft>) =>
    setGallery((items) => items.map((item, at) => (at === index ? { ...item, ...value } : item)));
  const move = (index: number, direction: -1 | 1) =>
    setGallery((items) => {
      const target = index + direction;
      if (target < 0 || target >= items.length) return items;
      const reordered = [...items];
      [reordered[index], reordered[target]] = [reordered[target]!, reordered[index]!];
      return reordered;
    });

  return (
    <Wrapper
      className="et-form"
      aria-label={`Médias du véhicule ${vehicle.code}`}
      {...(readOnly ? {} : { onSubmit: submit })}
    >
      <h3>Médias du véhicule</h3>
      <fieldset className="ops-content-item">
        <legend>Photo principale</legend>
        <MediaPicker
          mediaId={primaryMediaId}
          readOnly={readOnly}
          required={false}
          onChange={(mediaId) => setPrimaryMediaId(mediaId ?? null)}
        />
      </fieldset>

      <fieldset className="ops-content-item">
        <legend>Galerie</legend>
        {gallery.length === 0 ? <p className="et-hint">Aucune photo de galerie.</p> : null}
        {gallery.map((item, index) => (
          <section key={item.key} className="ops-content-item" aria-label={`Photo ${index + 1}`}>
            <div className="ops-content-item__head">
              <h4>Photo {index + 1}</h4>
              {readOnly ? null : (
                <div className="ops-content-item__actions">
                  <button
                    type="button"
                    className="et-button et-button--secondary"
                    disabled={index === 0}
                    aria-label={`Monter la photo ${index + 1}`}
                    onClick={() => move(index, -1)}
                  >
                    Monter
                  </button>
                  <button
                    type="button"
                    className="et-button et-button--secondary"
                    disabled={index === gallery.length - 1}
                    aria-label={`Descendre la photo ${index + 1}`}
                    onClick={() => move(index, 1)}
                  >
                    Descendre
                  </button>
                  <button
                    type="button"
                    className="et-button et-button--secondary"
                    onClick={() => setGallery((items) => items.filter((_, at) => at !== index))}
                  >
                    Retirer
                  </button>
                </div>
              )}
            </div>
            <MediaPicker
              mediaId={item.mediaId}
              readOnly={readOnly}
              required
              onChange={(mediaId) => update(index, { mediaId: mediaId ?? null })}
            />
            <div className="et-field">
              <label htmlFor={`${id}-kind-${index}`}>Type de photo (facultatif)</label>
              <select
                id={`${id}-kind-${index}`}
                className="et-select"
                value={item.kind ?? ''}
                disabled={readOnly}
                onChange={(event) =>
                  update(index, {
                    kind: (event.target.value || null) as VehicleMediaKind | null,
                  })
                }
              >
                <option value="">Non précisé</option>
                {KIND_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </section>
        ))}
        {readOnly || gallery.length >= 6 ? null : (
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => {
              nextKey.current += 1;
              setGallery((items) => [
                ...items,
                { key: `new-${nextKey.current}`, mediaId: null, kind: null },
              ]);
            }}
          >
            + Ajouter une photo
          </button>
        )}
      </fieldset>

      {readOnly ? (
        <p className="et-hint">
          {vehicle.status === 'RETIRED'
            ? 'Les médias d’un véhicule retiré sont définitifs.'
            : 'La modification demande fleet.manage et media.read.'}
        </p>
      ) : (
        <button className="et-button" type="submit" disabled={busy || incomplete}>
          Enregistrer les médias
        </button>
      )}
    </Wrapper>
  );
}
