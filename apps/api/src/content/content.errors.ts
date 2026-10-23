import { PublicApiError } from '../auth/http/public-api-error.js';

export interface ContentIssue {
  path: string;
  message: string;
}

/** A document that does not match the content model; issues are server-built. */
export class ContentDocumentInvalidError extends PublicApiError {
  override readonly publicDetails: Readonly<Record<string, unknown>>;

  constructor(issues: readonly ContentIssue[]) {
    super(
      422,
      'CONTENT_DOCUMENT_INVALID',
      'Le contenu ne respecte pas le modèle de la page. Corrigez les champs indiqués.',
    );
    this.publicDetails = { issues: issues.slice(0, 50) };
  }
}

export const ContentErrors = {
  entryNotFound: () => new PublicApiError(404, 'CONTENT_ENTRY_NOT_FOUND', 'Contenu introuvable.'),
  revisionNotFound: () =>
    new PublicApiError(404, 'CONTENT_REVISION_NOT_FOUND', 'Révision introuvable.'),
  pageNotFound: () => new PublicApiError(404, 'CONTENT_PAGE_NOT_FOUND', 'Page introuvable.'),
  siteNotPublished: () =>
    new PublicApiError(
      404,
      'CONTENT_SITE_NOT_PUBLISHED',
      'Les réglages du site ne sont pas publiés.',
    ),
  pathTaken: () =>
    new PublicApiError(409, 'CONTENT_PATH_TAKEN', 'Une page utilise déjà ce chemin.'),
  singletonExists: () =>
    new PublicApiError(409, 'CONTENT_SINGLETON_EXISTS', 'Ce contenu existe déjà.'),
  draftConflict: () =>
    new PublicApiError(
      409,
      'CONTENT_DRAFT_CONFLICT',
      'Le brouillon a été modifié entre-temps. Rechargez-le avant de continuer.',
    ),
  noDraft: () => new PublicApiError(409, 'CONTENT_NO_DRAFT', 'Aucun brouillon à publier.'),
  publicContactRequired: () =>
    new PublicApiError(
      422,
      'CONTENT_PUBLIC_CONTACT_REQUIRED',
      'Publiez au moins un e-mail ou un téléphone dans les réglages du site avant de publier la page fret.',
    ),
  draftExists: () =>
    new PublicApiError(
      409,
      'CONTENT_DRAFT_EXISTS',
      'Un brouillon est en cours : publiez-le ou abandonnez-le avant de restaurer une version.',
    ),
  documentInvalid: (issues: readonly ContentIssue[]) => new ContentDocumentInvalidError(issues),
  seoPermissionRequired: () =>
    new PublicApiError(
      403,
      'CONTENT_SEO_PERMISSION_REQUIRED',
      'Modifier le référencement (titre, description, indexation) demande la permission seo.manage.',
    ),
  archiveForbidden: () =>
    new PublicApiError(
      422,
      'CONTENT_ARCHIVE_FORBIDDEN',
      'La page d’accueil et les réglages du site ne peuvent pas être archivés.',
    ),
  notArchived: () =>
    new PublicApiError(409, 'CONTENT_NOT_ARCHIVED', 'Cette page n’est pas archivée.'),
  alreadyArchived: () =>
    new PublicApiError(409, 'CONTENT_ALREADY_ARCHIVED', 'Cette page est déjà archivée.'),
};
