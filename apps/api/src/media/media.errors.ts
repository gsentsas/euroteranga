import { PublicApiError } from '../auth/http/public-api-error.js';

export interface MediaUsage {
  kind: string;
  key: string;
  status: 'DRAFT' | 'PUBLISHED';
  /** The content entry is archived (not served) but can be unarchived. */
  entryArchived: boolean;
}

class MediaInUseError extends PublicApiError {
  override readonly publicDetails: Readonly<Record<string, unknown>>;

  constructor(usages: readonly MediaUsage[]) {
    super(
      409,
      'MEDIA_IN_USE',
      'Cette image est utilisée par un contenu publié ou en brouillon : retirez-la d’abord de ces contenus.',
    );
    this.publicDetails = { usages: usages.slice(0, 50) };
  }
}

class MediaDuplicateError extends PublicApiError {
  override readonly publicDetails: Readonly<Record<string, unknown>>;

  constructor(mediaId: string) {
    super(409, 'MEDIA_DUPLICATE', 'Cette image est déjà dans la médiathèque.');
    this.publicDetails = { mediaId };
  }
}

export const MediaErrors = {
  storageDisabled: () =>
    new PublicApiError(
      503,
      'MEDIA_STORAGE_DISABLED',
      'La médiathèque n’est pas activée sur cet environnement.',
    ),
  unavailable: () =>
    new PublicApiError(
      503,
      'MEDIA_UNAVAILABLE',
      'La médiathèque est momentanément indisponible. Réessayez plus tard.',
    ),
  busy: () =>
    new PublicApiError(
      503,
      'MEDIA_BUSY',
      'D’autres images sont en cours de traitement. Réessayez dans quelques instants.',
      { 'Retry-After': '5' },
    ),
  malformed: () =>
    new PublicApiError(
      400,
      'MEDIA_UPLOAD_MALFORMED',
      'Envoi invalide : un seul fichier « file » et les champs altText, caption, credit, focalX, focalY, replaces sont attendus.',
    ),
  empty: () => new PublicApiError(400, 'MEDIA_UPLOAD_EMPTY', 'Le fichier est vide.'),
  aborted: () =>
    new PublicApiError(400, 'MEDIA_UPLOAD_ABORTED', 'L’envoi a été interrompu avant la fin.'),
  timeout: () =>
    new PublicApiError(
      408,
      'MEDIA_UPLOAD_TIMEOUT',
      'L’envoi a pris trop de temps : réessayez avec une connexion plus stable ou une image plus légère.',
    ),
  tooLarge: (maxBytes: number) =>
    new PublicApiError(
      413,
      'MEDIA_UPLOAD_TOO_LARGE',
      `Le fichier dépasse ${Math.floor(maxBytes / (1024 * 1024))} Mo.`,
    ),
  unsupported: () =>
    new PublicApiError(415, 'MEDIA_FORMAT_UNSUPPORTED', 'Formats acceptés : JPEG, PNG et WebP.'),
  invalidImage: () =>
    new PublicApiError(422, 'MEDIA_IMAGE_INVALID', 'L’image est illisible ou corrompue.'),
  tooManyPixels: () =>
    new PublicApiError(
      422,
      'MEDIA_IMAGE_TOO_LARGE',
      'L’image est trop grande (20 000 pixels de côté au plus, et un nombre de pixels limité) : réduisez ses dimensions avant de l’envoyer.',
    ),
  tooSmall: () =>
    new PublicApiError(
      422,
      'MEDIA_IMAGE_TOO_SMALL',
      'L’image est trop petite : 200 pixels au moins de chaque côté.',
    ),
  animated: () =>
    new PublicApiError(
      422,
      'MEDIA_IMAGE_ANIMATED',
      'Les images animées ne sont pas acceptées : envoyez une image fixe.',
    ),
  duplicate: (mediaId: string) => new MediaDuplicateError(mediaId),
  notFound: () => new PublicApiError(404, 'MEDIA_NOT_FOUND', 'Image introuvable.'),
  inUse: (usages: readonly MediaUsage[]) => new MediaInUseError(usages),
  /** Archiving is terminal: an archived image can no longer change. */
  archived: () =>
    new PublicApiError(
      409,
      'MEDIA_ARCHIVED',
      'Cette image est archivée : elle ne peut plus être modifiée ni réutilisée. Importez-la à nouveau si besoin.',
    ),
};
