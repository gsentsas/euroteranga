import { PublicApiError } from '../auth/http/public-api-error.js';

export const AuthorizationErrors = {
  forbidden: () => new PublicApiError(403, 'FORBIDDEN', 'Action non autorisée.'),
  roleNotFound: () => new PublicApiError(404, 'ROLE_NOT_FOUND', 'Rôle introuvable.'),
  identityNotFound: () =>
    new PublicApiError(404, 'IDENTITY_NOT_FOUND', 'Identité introuvable.'),
  roleAlreadyAssigned: () =>
    new PublicApiError(409, 'ROLE_ALREADY_ASSIGNED', 'Ce rôle est déjà attribué.'),
  roleNotAssigned: () =>
    new PublicApiError(404, 'ROLE_NOT_ASSIGNED', "Ce rôle n'est pas attribué."),
  invalidStaffTarget: () =>
    new PublicApiError(400, 'INVALID_STAFF_TARGET', 'Cette identité ne peut pas recevoir ce rôle.'),
  staffAlreadyExists: () =>
    new PublicApiError(409, 'STAFF_ALREADY_EXISTS', 'Un compte STAFF existe déjà pour cette adresse.'),
  invitationInvalid: () =>
    new PublicApiError(400, 'INVALID_OR_EXPIRED_INVITATION', 'Invitation invalide ou expirée.'),
  mfaEnrollmentNotAuthorized: () =>
    new PublicApiError(401, 'MFA_ENROLLMENT_NOT_AUTHORIZED', 'Enrôlement MFA non autorisé.'),
  mfaAlreadyEnabled: () =>
    new PublicApiError(409, 'MFA_ALREADY_ENABLED', 'La double authentification est déjà activée.'),
};
