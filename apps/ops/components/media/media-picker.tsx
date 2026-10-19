'use client';

import type { MediaAsset, PublicMedia } from '@euroteranga/auth-client';
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { auth } from '../../lib/auth';
import { MediaThumb } from './media-shared';

type Current = { status: 'loading' } | { status: 'found'; media: PublicMedia } | { status: 'gone' };

const PAGE_SIZE = 24;

/**
 * The image shown for a media id, read from the public endpoint: it answers
 * active images only, exactly what the website and the save check accept.
 */
function useCurrentMedia(mediaId: string | null): Current | null {
  const [current, setCurrent] = useState<Current | null>(null);
  useEffect(() => {
    if (!mediaId) {
      setCurrent(null);
      return;
    }
    let cancelled = false;
    setCurrent({ status: 'loading' });
    void auth.media.many([mediaId]).then((result) => {
      if (cancelled) return;
      const media = result.ok ? result.data.items.find((item) => item.id === mediaId) : undefined;
      setCurrent(media ? { status: 'found', media } : { status: 'gone' });
    });
    return () => {
      cancelled = true;
    };
  }, [mediaId]);
  return current;
}

/** Active images to choose from (media.read), with a filter on loaded ones. */
function PickerPanel({
  id,
  selected,
  onPick,
  onClose,
}: {
  id: string;
  selected: string | null;
  onPick: (media: MediaAsset) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<MediaAsset[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async (cursor?: string) => {
    const result = await auth.admin.media.list({
      status: 'ACTIVE',
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (!result.ok) {
      setError(
        result.error.status === 403
          ? 'Votre rôle ne donne pas accès à la médiathèque (media.read).'
          : result.error.message,
      );
      setItems([]);
      return;
    }
    setItems((previous) =>
      cursor ? [...(previous ?? []), ...result.data.items] : result.data.items,
    );
    setNextCursor(result.data.nextCursor);
  }, []);

  useEffect(() => {
    headingRef.current?.focus();
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const words = search.trim().toLocaleLowerCase('fr').split(/\s+/).filter(Boolean);
    if (!items || words.length === 0) return items;
    return items.filter((item) =>
      words.every((word) =>
        [item.altText, item.caption, item.credit]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase('fr')
          .includes(word),
      ),
    );
  }, [items, search]);

  return (
    <div
      className="ops-media-picker"
      role="region"
      aria-labelledby={`${id}-title`}
      data-testid="media-picker"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="ops-content-item__head">
        <h4 id={`${id}-title`} ref={headingRef} tabIndex={-1}>
          Choisir une image de la médiathèque
        </h4>
        <button type="button" className="et-button et-button--secondary" onClick={onClose}>
          Fermer
        </button>
      </div>
      {error ? <p className="et-error">{error}</p> : null}
      <div className="et-field">
        <label htmlFor={`${id}-search`}>Rechercher</label>
        <input
          id={`${id}-search`}
          className="et-input"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {!shown ? (
        <p role="status">Chargement des images…</p>
      ) : shown.length === 0 && !error ? (
        <p className="et-hint">
          {search.trim() ? 'Aucune image ne correspond.' : 'La médiathèque est vide.'}{' '}
          <Link href="/mediatheque" target="_blank" rel="noopener">
            Importer une image dans la médiathèque
          </Link>
        </p>
      ) : (
        <ul className="ops-media-grid ops-media-grid--compact">
          {shown.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="ops-media-card"
                aria-pressed={selected === item.id}
                onClick={() => onPick(item)}
              >
                <MediaThumb
                  className="ops-media-card__image"
                  renditions={item.renditions}
                  alt=""
                  width={480}
                  focalX={item.focalX}
                  focalY={item.focalY}
                />
                <span className="ops-media-card__alt">
                  <span className="et-visually-hidden">Choisir : </span>
                  {item.altText}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? (
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void load(nextCursor)}
        >
          Afficher plus d’images
        </button>
      ) : null}
    </div>
  );
}

/** Media field of the content editor: the chosen image, or a choice among active ones. */
export function MediaPicker({
  mediaId,
  readOnly,
  required,
  describedBy,
  onChange,
}: {
  mediaId: string | null;
  readOnly: boolean;
  required: boolean;
  describedBy?: string;
  onChange: (mediaId: string | undefined) => void;
}) {
  const id = useId();
  const current = useCurrentMedia(mediaId);
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <div className="ops-media-field">
      {mediaId === null ? (
        <p className="et-hint">Aucune image.</p>
      ) : current?.status === 'found' ? (
        <figure className="ops-media-field__current">
          <MediaThumb
            renditions={current.media.renditions}
            alt={current.media.altText}
            width={480}
            focalX={current.media.focalX}
            focalY={current.media.focalY}
          />
          <figcaption>{current.media.altText}</figcaption>
        </figure>
      ) : current?.status === 'gone' ? (
        <p className="ops-content-warning" role="alert">
          Image introuvable ou archivée dans la médiathèque : choisissez-en une autre
          {required ? '' : ' ou retirez-la'}.
        </p>
      ) : (
        <p role="status">Chargement de l’image…</p>
      )}
      {readOnly ? null : (
        <div className="ops-content-item__actions">
          <button
            ref={toggleRef}
            type="button"
            className="et-button et-button--secondary"
            aria-expanded={open}
            aria-describedby={describedBy}
            onClick={() => setOpen(!open)}
          >
            {mediaId ? 'Changer d’image' : 'Choisir une image'}
          </button>
          {mediaId && !required ? (
            <button
              type="button"
              className="et-button et-button--secondary"
              onClick={() => onChange(undefined)}
            >
              Retirer l’image
            </button>
          ) : null}
        </div>
      )}
      {open && !readOnly ? (
        <PickerPanel
          id={id}
          selected={mediaId}
          onPick={(media) => {
            onChange(media.id);
            close();
          }}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
