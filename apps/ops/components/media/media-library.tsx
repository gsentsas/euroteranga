'use client';

import type { MediaAsset, MediaStatus, MediaUpdateInput } from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsConfirmSubmit } from '../ops-confirm-submit';
import { useCan } from '../staff-access';
import {
  ALT_TEXT_MAX,
  ARCHIVE_REASON_MAX,
  ARCHIVE_REASON_MIN,
  CAPTION_MAX,
  CREDIT_MAX,
  formatBytes,
  formatDate,
  MEDIA_ACCEPT,
  MEDIA_TYPES,
  MediaThumb,
  renditionFor,
  usageLabel,
} from './media-shared';

/** Largest file the API can be configured to accept (PUBLIC_MEDIA_MAX_BYTES). */
const CLIENT_MAX_BYTES = 20 * 1024 * 1024;
/** Width of the local preview drawn before the upload. */
const PREVIEW_WIDTH = 960;

/**
 * Local preview of a chosen file, decoded by the browser and redrawn into a
 * canvas: the page shows a re-encoded bitmap, never the file itself (nor an
 * object URL of it). Null when the browser cannot decode the file.
 */
async function previewOf(file: File): Promise<string | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PREVIEW_WIDTH / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
const PAGE_SIZE = 48;

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span className="ops-content-count" aria-hidden="true">
      {value.length}/{max}
    </span>
  );
}

interface Described {
  altText: string;
  caption: string;
  credit: string;
  focalX: number;
  focalY: number;
}

const describedOf = (asset: MediaAsset | null): Described => ({
  altText: asset?.altText ?? '',
  caption: asset?.caption ?? '',
  credit: asset?.credit ?? '',
  focalX: asset?.focalX ?? 50,
  focalY: asset?.focalY ?? 50,
});

/** Alternative text, caption and credit, shared by the upload and the edit forms. */
function DescriptionFields({
  idPrefix,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string;
  value: Described;
  onChange: (next: Described) => void;
  disabled?: boolean;
}) {
  const set = (key: 'altText' | 'caption' | 'credit', text: string) =>
    onChange({ ...value, [key]: text });
  return (
    <>
      <div className="et-field ops-content-field">
        <label htmlFor={`${idPrefix}-alt`}>Texte alternatif</label>
        <textarea
          id={`${idPrefix}-alt`}
          className="et-input"
          required
          rows={2}
          maxLength={ALT_TEXT_MAX}
          disabled={disabled}
          value={value.altText}
          aria-describedby={`${idPrefix}-alt-hint`}
          onChange={(event) => set('altText', event.target.value)}
        />
        <div className="ops-content-field__meta">
          <p id={`${idPrefix}-alt-hint`} className="et-hint">
            Ce que lit un lecteur d’écran à la place de l’image : décrivez ce qu’elle montre (pas «
            image de… »).
          </p>
          <Counter value={value.altText} max={ALT_TEXT_MAX} />
        </div>
      </div>
      <div className="et-field ops-content-field">
        <label htmlFor={`${idPrefix}-caption`}>
          Légende <span className="ops-content-optional">(facultatif)</span>
        </label>
        <input
          id={`${idPrefix}-caption`}
          className="et-input"
          maxLength={CAPTION_MAX}
          disabled={disabled}
          value={value.caption}
          onChange={(event) => set('caption', event.target.value)}
        />
      </div>
      <div className="et-field ops-content-field">
        <label htmlFor={`${idPrefix}-credit`}>
          Crédit photo <span className="ops-content-optional">(facultatif)</span>
        </label>
        <input
          id={`${idPrefix}-credit`}
          className="et-input"
          maxLength={CREDIT_MAX}
          disabled={disabled}
          value={value.credit}
          aria-describedby={`${idPrefix}-credit-hint`}
          onChange={(event) => set('credit', event.target.value)}
        />
        <p id={`${idPrefix}-credit-hint`} className="et-hint">
          Auteur ou détenteur des droits, affiché sous l’image. N’importez que des images dont vous
          avez les droits.
        </p>
      </div>
    </>
  );
}

/**
 * Point kept visible when the website crops the image (gallery tiles, narrow
 * screens). Sliders work with the keyboard; clicking the image sets the point.
 */
function FocalPointEditor({
  idPrefix,
  src,
  alt,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string;
  src: string | null;
  alt: string;
  value: { focalX: number; focalY: number };
  onChange: (focalX: number, focalY: number) => void;
  disabled?: boolean;
}) {
  const clamp = (number: number) => Math.min(100, Math.max(0, Math.round(number)));
  return (
    <fieldset className="ops-media-focal" disabled={disabled}>
      <legend>Point focal</legend>
      {src ? (
        <div className="ops-media-focal__stage">
          {/* eslint-disable-next-line @next/next/no-img-element -- canvas preview or API rendition */}
          <img
            src={src}
            alt=""
            onClick={(event) => {
              if (disabled) return;
              const box = event.currentTarget.getBoundingClientRect();
              onChange(
                clamp(((event.clientX - box.left) / box.width) * 100),
                clamp(((event.clientY - box.top) / box.height) * 100),
              );
            }}
          />
          <span
            className="ops-media-focal__marker"
            aria-hidden="true"
            style={{ left: `${value.focalX}%`, top: `${value.focalY}%` }}
          />
        </div>
      ) : null}
      <div className="ops-media-focal__sliders">
        <label htmlFor={`${idPrefix}-focal-x`}>
          Horizontal <span className="ops-content-count">{value.focalX} %</span>
        </label>
        <input
          id={`${idPrefix}-focal-x`}
          type="range"
          min={0}
          max={100}
          value={value.focalX}
          onChange={(event) => onChange(Number(event.target.value), value.focalY)}
        />
        <label htmlFor={`${idPrefix}-focal-y`}>
          Vertical <span className="ops-content-count">{value.focalY} %</span>
        </label>
        <input
          id={`${idPrefix}-focal-y`}
          type="range"
          min={0}
          max={100}
          value={value.focalY}
          onChange={(event) => onChange(value.focalX, Number(event.target.value))}
        />
      </div>
      {src ? (
        <div className="ops-media-crops" aria-label={`Recadrages de « ${alt} »`} role="group">
          {(
            [
              ['16 / 9', 'Bandeau'],
              ['4 / 3', 'Galerie'],
              ['1 / 1', 'Carré'],
            ] as const
          ).map(([ratio, label]) => (
            <figure key={ratio}>
              {/* eslint-disable-next-line @next/next/no-img-element -- same preview, cropped */}
              <img
                src={src}
                alt=""
                style={{
                  aspectRatio: ratio,
                  objectPosition: `${value.focalX}% ${value.focalY}%`,
                }}
              />
              <figcaption>{label}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}

/**
 * New image. When `replaces` is set, it starts from the replaced image's
 * description; the replaced image itself is kept untouched (immutable).
 */
function MediaUploadForm({
  replaces,
  onUploaded,
  onOpen,
  onCancel,
}: {
  replaces: MediaAsset | null;
  onUploaded: (asset: MediaAsset) => void;
  onOpen: (id: string) => void;
  onCancel: () => void;
}) {
  const idPrefix = useId();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [described, setDescribed] = useState<Described>(() => describedOf(replaces));
  const [error, setError] = useState<string | null>(null);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPreview(null);
    if (!file) return;
    let cancelled = false;
    void previewOf(file).then((url) => {
      if (!cancelled) setPreview(url);
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const choose = (chosen: File | null) => {
    setError(null);
    setDuplicateId(null);
    if (chosen && !MEDIA_TYPES.has(chosen.type)) {
      setFile(null);
      setError('Formats acceptés : JPEG, PNG et WebP (pas de SVG, GIF ni HEIC).');
      return;
    }
    if (chosen && chosen.size > CLIENT_MAX_BYTES) {
      setFile(null);
      setError('Ce fichier dépasse 20 Mo : réduisez-le avant de l’importer.');
      return;
    }
    setFile(chosen);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!file) {
      setError('Choisissez une image à importer.');
      fileRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setDuplicateId(null);
    try {
      const result = await auth.admin.media.upload({
        file,
        altText: described.altText.trim(),
        ...(described.caption.trim() ? { caption: described.caption.trim() } : {}),
        ...(described.credit.trim() ? { credit: described.credit.trim() } : {}),
        focalX: described.focalX,
        focalY: described.focalY,
        ...(replaces ? { replaces: replaces.id } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        setDuplicateId(result.error.details?.mediaId ?? null);
        return;
      }
      onUploaded(result.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="et-form ops-content-section ops-media-upload"
      aria-labelledby={`${idPrefix}-title`}
      onSubmit={submit}
      data-testid="media-upload-form"
    >
      <h2 id={`${idPrefix}-title`}>
        {replaces ? 'Remplacer par une nouvelle image' : 'Importer une image'}
      </h2>
      {replaces ? (
        <p className="et-hint">
          L’image actuelle reste telle quelle dans la médiathèque et dans l’historique des pages.
          Une fois la nouvelle importée, choisissez-la dans les contenus qui utilisent l’ancienne,
          puis archivez l’ancienne.
        </p>
      ) : null}
      <FormAlert message={error} />
      {duplicateId ? (
        <p>
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => onOpen(duplicateId)}
          >
            Ouvrir l’image déjà présente
          </button>
        </p>
      ) : null}
      <div className="et-field ops-content-field">
        <label htmlFor={`${idPrefix}-file`}>Fichier image</label>
        <input
          ref={fileRef}
          id={`${idPrefix}-file`}
          className="et-input"
          type="file"
          accept={MEDIA_ACCEPT}
          aria-describedby={`${idPrefix}-file-hint`}
          onChange={(event) => choose(event.target.files?.[0] ?? null)}
        />
        <p id={`${idPrefix}-file-hint`} className="et-hint">
          JPEG, PNG ou WebP, 200 pixels au moins de côté. L’image est réencodée en WebP à plusieurs
          tailles ; ses métadonnées (appareil, position GPS…) sont supprimées et le fichier envoyé
          n’est pas conservé.
        </p>
      </div>
      <DescriptionFields idPrefix={idPrefix} value={described} onChange={setDescribed} />
      <FocalPointEditor
        idPrefix={idPrefix}
        src={preview}
        alt={described.altText}
        value={described}
        onChange={(focalX, focalY) => setDescribed({ ...described, focalX, focalY })}
      />
      <div className="ops-content-item__actions">
        <button className="et-button" type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? 'Import en cours…' : 'Importer l’image'}
        </button>
        <button type="button" className="et-button et-button--secondary" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

function MediaDetail({
  id,
  canManage,
  onChanged,
  onReplace,
  onClose,
}: {
  id: string;
  canManage: boolean;
  onChanged: (asset: MediaAsset) => void;
  onReplace: (asset: MediaAsset) => void;
  onClose: () => void;
}) {
  const idPrefix = useId();
  const [asset, setAsset] = useState<MediaAsset | null>(null);
  const [described, setDescribed] = useState<Described>(describedOf(null));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    const result = await auth.admin.media.detail(id);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setAsset(result.data);
    setDescribed(describedOf(result.data));
  }, [id]);

  useEffect(() => {
    setAsset(null);
    setError(null);
    setNotice(null);
    setReason('');
    void load();
  }, [load]);

  useEffect(() => {
    if (asset) headingRef.current?.focus();
    // Focus the detail once per opened image, not on every refresh.
  }, [asset?.id]);

  if (!asset) {
    return (
      <section className="ops-content-section" aria-label="Image">
        <FormAlert message={error} />
        {error ? null : <p role="status">Chargement de l’image…</p>}
      </section>
    );
  }

  const active = asset.status === 'ACTIVE';
  const editable = canManage && active;
  const usages = asset.usages ?? [];
  const preview = renditionFor(asset.renditions, 960);
  const before = describedOf(asset);
  const changes: MediaUpdateInput = {};
  if (described.altText.trim() !== before.altText) changes.altText = described.altText.trim();
  if (described.caption.trim() !== before.caption)
    changes.caption = described.caption.trim() || null;
  if (described.credit.trim() !== before.credit) changes.credit = described.credit.trim() || null;
  if (described.focalX !== before.focalX) changes.focalX = described.focalX;
  if (described.focalY !== before.focalY) changes.focalY = described.focalY;
  const dirty = Object.keys(changes).length > 0;

  const act = async (action: () => ReturnType<typeof auth.admin.media.update>, done: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error.message);
        if (result.error.code === 'MEDIA_IN_USE') await load();
        return;
      }
      setAsset(result.data);
      setDescribed(describedOf(result.data));
      setNotice(done);
      onChanged(result.data);
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    void act(() => auth.admin.media.update(asset.id, changes), 'Description enregistrée.');
  };

  const archive = (event: FormEvent) => {
    event.preventDefault();
    void act(
      () => auth.admin.media.archive(asset.id, reason.trim()),
      'Image archivée : elle n’est plus diffusée ni proposée dans les contenus.',
    );
  };

  return (
    <section
      className="ops-content-section ops-media-detail"
      aria-labelledby={`${idPrefix}-title`}
      data-testid="media-detail"
    >
      <div className="ops-content-editor__head">
        <h2 id={`${idPrefix}-title`} ref={headingRef} tabIndex={-1}>
          {asset.altText}
        </h2>
        <div className="ops-content-badges">
          <span
            className={`ops-content-badge ${active ? 'ops-content-badge--live' : 'ops-content-badge--draft'}`}
          >
            {active ? 'Active' : 'Archivée'}
          </span>
          {usages.length > 0 ? (
            <span className="ops-content-badge">
              Utilisée par {usages.length} contenu{usages.length > 1 ? 's' : ''}
            </span>
          ) : null}
        </div>
      </div>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      {active ? null : (
        <p className="ops-content-warning">
          Image archivée le {asset.archivedAt ? formatDate(asset.archivedAt) : '—'}
          {asset.archivedBy ? ` par ${asset.archivedBy.email}` : ''} : « {asset.archiveReason} ».
          Elle n’est plus diffusée et ne peut plus être modifiée ni réutilisée ; les anciennes
          versions des pages gardent leur référence.
        </p>
      )}

      <form className="et-form ops-media-describe" onSubmit={save} aria-label="Description">
        <DescriptionFields
          idPrefix={idPrefix}
          value={described}
          onChange={setDescribed}
          disabled={!editable}
        />
        <FocalPointEditor
          idPrefix={idPrefix}
          src={active && preview ? auth.media.url(preview.path) : null}
          alt={asset.altText}
          value={described}
          onChange={(focalX, focalY) => setDescribed({ ...described, focalX, focalY })}
          disabled={!editable}
        />
        {editable ? (
          <div className="ops-content-item__actions">
            <button className="et-button" type="submit" disabled={busy || !dirty}>
              Enregistrer la description
            </button>
            {dirty ? (
              <button
                type="button"
                className="et-button et-button--secondary"
                onClick={() => setDescribed(before)}
              >
                Annuler les modifications
              </button>
            ) : null}
          </div>
        ) : null}
      </form>

      <section aria-labelledby={`${idPrefix}-usages`}>
        <h3 id={`${idPrefix}-usages`}>Utilisation</h3>
        {usages.length === 0 ? (
          <p className="et-hint">Aucun brouillon ni aucune page en ligne n’affiche cette image.</p>
        ) : (
          <>
            <ul>
              {usages.map((usage) => (
                <li key={`${usage.kind}-${usage.key}-${usage.status}`}>{usageLabel(usage)}</li>
              ))}
            </ul>
            <p>
              <Link href="/contenus">Ouvrir les contenus du site</Link>
            </p>
          </>
        )}
      </section>

      <dl className="ops-content-meta">
        <dt>Dimensions</dt>
        <dd>
          {asset.width} × {asset.height} px (fichier reçu : {asset.sourceFormat.toUpperCase()},{' '}
          {formatBytes(asset.sourceBytes)}, non conservé)
        </dd>
        <dt>Tailles diffusées</dt>
        <dd>
          {asset.renditions
            .map((rendition) => `${rendition.width} px (${formatBytes(rendition.bytes)})`)
            .join(', ')}{' '}
          — WebP sans métadonnées
        </dd>
        <dt>Importée</dt>
        <dd>
          {formatDate(asset.createdAt)}
          {asset.createdBy ? ` par ${asset.createdBy.email}` : ''}
        </dd>
        <dt>Modifiée</dt>
        <dd>
          {formatDate(asset.updatedAt)}
          {asset.updatedBy ? ` par ${asset.updatedBy.email}` : ''}
        </dd>
      </dl>

      {editable ? (
        <div className="ops-content-item__actions">
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => onReplace(asset)}
          >
            Remplacer par une nouvelle image
          </button>
        </div>
      ) : null}

      {editable ? (
        <form className="et-form ops-media-archive" onSubmit={archive} aria-label="Archiver">
          <h3>Archiver</h3>
          {usages.length > 0 ? (
            <p className="et-hint">
              Retirez d’abord l’image des contenus ci-dessus (brouillons compris) : une image
              affichée ne peut pas être archivée.
            </p>
          ) : (
            <>
              <div className="et-field ops-content-field">
                <label htmlFor={`${idPrefix}-reason`}>Motif</label>
                <input
                  id={`${idPrefix}-reason`}
                  className="et-input"
                  required
                  minLength={ARCHIVE_REASON_MIN}
                  maxLength={ARCHIVE_REASON_MAX}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <OpsConfirmSubmit
                actionLabel="Archiver l’image"
                confirmLabel="Archiver définitivement"
                title="Archiver cette image ?"
                description="L’archivage est définitif : l’image ne sera plus diffusée ni proposée. Pour la réutiliser, il faudra l’importer à nouveau."
                disabled={busy || reason.trim().length < ARCHIVE_REASON_MIN}
              />
            </>
          )}
        </form>
      ) : null}

      <p>
        <button type="button" className="et-button et-button--secondary" onClick={onClose}>
          Fermer la fiche
        </button>
      </p>
    </section>
  );
}

/** MEDIA-1 public media library (media.read; changes need media.manage). */
export function MediaLibrary() {
  const canManage = useCan('media.manage');
  const [status, setStatus] = useState<MediaStatus>('ACTIVE');
  const [items, setItems] = useState<MediaAsset[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [storageEnabled, setStorageEnabled] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ replaces: MediaAsset | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.media.list({
        status,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setStorageEnabled(result.data.storageEnabled);
      setItems((previous) =>
        cursor ? [...(previous ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [status],
  );

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const words = search.trim().toLocaleLowerCase('fr').split(/\s+/).filter(Boolean);
    if (!items || words.length === 0) return items;
    return items.filter((item) => {
      const text = [item.altText, item.caption, item.credit]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('fr');
      return words.every((word) => text.includes(word));
    });
  }, [items, search]);

  const replaceInList = (asset: MediaAsset) =>
    setItems((previous) =>
      (previous ?? [])
        .map((item) => (item.id === asset.id ? asset : item))
        .filter((item) => item.status === status),
    );

  return (
    <div className="et-network ops-media" data-testid="media-library">
      <p>
        Les images du site public. Chaque image est réencodée en WebP sans métadonnées et ne change
        plus : pour la remplacer, importez-en une nouvelle. Une image affichée par une page ne peut
        pas être archivée, et l’archivage est définitif.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      {!storageEnabled ? (
        <p className="ops-content-warning">
          L’import d’images n’est pas activé sur cet environnement : la médiathèque est en lecture
          seule.
        </p>
      ) : null}

      <div className="ops-media-toolbar">
        <div role="group" aria-label="Statut des images" className="ops-content-preview__sizes">
          {(
            [
              ['ACTIVE', 'Actives'],
              ['ARCHIVED', 'Archivées'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={value === status ? 'et-button' : 'et-button et-button--secondary'}
              aria-pressed={value === status}
              onClick={() => {
                setStatus(value);
                setSelected(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="et-field ops-media-search">
          <label htmlFor="media-search">Rechercher</label>
          <input
            id="media-search"
            className="et-input"
            type="search"
            value={search}
            placeholder="Texte alternatif, légende, crédit"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {canManage && storageEnabled && !upload ? (
          <button
            type="button"
            className="et-button"
            onClick={() => {
              setNotice(null);
              setUpload({ replaces: null });
            }}
          >
            Importer une image
          </button>
        ) : null}
      </div>

      <div className="ops-content-workspace">
        <section aria-labelledby="media-grid-title" className="ops-content-form">
          <h2 id="media-grid-title" className="et-visually-hidden">
            {status === 'ACTIVE' ? 'Images actives' : 'Images archivées'}
          </h2>
          {!shown ? (
            <p role="status">Chargement des images…</p>
          ) : shown.length === 0 ? (
            <p className="et-hint">
              {search.trim()
                ? 'Aucune image chargée ne correspond à cette recherche.'
                : status === 'ACTIVE'
                  ? 'Aucune image pour l’instant.'
                  : 'Aucune image archivée.'}
            </p>
          ) : (
            <ul className="ops-media-grid" aria-label="Images">
              {shown.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="ops-media-card"
                    aria-pressed={selected === item.id}
                    onClick={() => {
                      setUpload(null);
                      setSelected(item.id);
                    }}
                  >
                    {item.status === 'ACTIVE' ? (
                      <MediaThumb
                        className="ops-media-card__image"
                        renditions={item.renditions}
                        alt=""
                        width={480}
                        focalX={item.focalX}
                        focalY={item.focalY}
                      />
                    ) : (
                      <span className="ops-media-card__image ops-media-card__archived">
                        Archivée
                      </span>
                    )}
                    <span className="ops-media-card__alt">{item.altText}</span>
                    <span className="ops-media-card__meta">
                      {item.width} × {item.height} px
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
        </section>
        <div className={`ops-content-side${upload || selected ? ' ops-media-side--active' : ''}`}>
          {upload ? (
            <MediaUploadForm
              key={upload.replaces?.id ?? 'new'}
              replaces={upload.replaces}
              onCancel={() => setUpload(null)}
              onOpen={(id) => {
                setUpload(null);
                setSelected(id);
              }}
              onUploaded={(asset) => {
                setUpload(null);
                setNotice(
                  upload.replaces
                    ? 'Nouvelle image importée. Choisissez-la dans les contenus qui utilisaient l’ancienne, puis archivez l’ancienne.'
                    : 'Image importée.',
                );
                if (status === 'ACTIVE') {
                  setItems((previous) => [asset, ...(previous ?? [])]);
                }
                setSelected(asset.id);
              }}
            />
          ) : selected ? (
            <MediaDetail
              id={selected}
              canManage={canManage}
              onChanged={replaceInList}
              onReplace={(asset) => {
                setNotice(null);
                setUpload({ replaces: asset });
              }}
              onClose={() => setSelected(null)}
            />
          ) : (
            <p className="et-hint ops-content-section">
              Choisissez une image pour voir sa description, où elle est utilisée, et la modifier.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
