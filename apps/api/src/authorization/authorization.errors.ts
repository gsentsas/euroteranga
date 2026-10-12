import { PublicApiError } from '../auth/http/public-api-error.js';

export const AuthorizationErrors = {
  forbidden: () => new PublicApiError(403, 'FORBIDDEN', 'Action non autorisée.'),
  roleNotFound: () => new PublicApiError(404, 'ROLE_NOT_FOUND', 'Rôle introuvable.'),
  identityNotFound: () => new PublicApiError(404, 'IDENTITY_NOT_FOUND', 'Identité introuvable.'),
  roleAlreadyAssigned: () =>
    new PublicApiError(409, 'ROLE_ALREADY_ASSIGNED', 'Ce rôle est déjà attribué.'),
  roleNotAssigned: () =>
    new PublicApiError(409, 'ROLE_NOT_ASSIGNED', "Ce rôle n'est pas attribué."),
  roleRealmMismatch: () =>
    new PublicApiError(
      400,
      'ROLE_REALM_MISMATCH',
      'Ce rôle ne peut pas être attribué à ce type de compte.',
    ),
  selfModificationForbidden: () =>
    new PublicApiError(
      403,
      'SELF_MODIFICATION_FORBIDDEN',
      'Vous ne pouvez pas modifier vos propres droits ou votre propre statut.',
    ),
  lastPrivilegedAdmin: () =>
    new PublicApiError(
      409,
      'LAST_PRIVILEGED_ADMIN',
      'Impossible : au moins un super administrateur actif doit subsister.',
    ),
  invalidStatusTransition: () =>
    new PublicApiError(409, 'INVALID_STATUS_TRANSITION', 'Changement de statut non autorisé.'),
  staffAlreadyExists: () =>
    new PublicApiError(
      409,
      'STAFF_ALREADY_EXISTS',
      'Un compte STAFF existe déjà pour cette adresse.',
    ),
  invitationInvalid: () =>
    new PublicApiError(400, 'INVALID_OR_EXPIRED_INVITATION', 'Invitation invalide ou expirée.'),
  mfaEnrollmentNotAuthorized: () =>
    new PublicApiError(
      403,
      'MFA_ENROLLMENT_NOT_AUTHORIZED',
      'La configuration de la double authentification doit être autorisée par un administrateur.',
    ),
  mfaAlreadyEnabled: () =>
    new PublicApiError(409, 'MFA_ALREADY_ENABLED', 'La double authentification est déjà activée.'),
};
