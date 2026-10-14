import { HttpException } from '@nestjs/common';

/**
 * An error whose code and message are safe to show to clients. Every public
 * message is written here, never derived from internal errors.
 */
export class PublicApiError extends HttpException {
  /**
   * Optional structured detail built by the server from stable codes (for
   * example check-in blockers). Never copied from an internal error.
   */
  readonly publicDetails: Readonly<Record<string, unknown>> | undefined = undefined;

  constructor(
    status: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super({ code, message: publicMessage }, status);
  }
}

export const AuthErrors = {
  /** Same response for unknown email, wrong password and unusable account. */
  invalidCredentials: () =>
    new PublicApiError(401, 'INVALID_CREDENTIALS', 'Email ou mot de passe incorrect.'),
  unauthenticated: () => new PublicApiError(401, 'UNAUTHENTICATED', 'Authentification requise.'),
  invalidToken: () =>
    new PublicApiError(400, 'INVALID_OR_EXPIRED_TOKEN', 'Lien invalide ou expiré.'),
  verificationFailed: () =>
    new PublicApiError(
      400,
      'VERIFICATION_FAILED',
      'Lien invalide ou expiré, ou mot de passe incorrect.',
    ),
  csrf: () => new PublicApiError(403, 'CSRF_TOKEN_INVALID', 'Requête refusée.'),
  origin: () => new PublicApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origine non autorisée.'),
  unsupportedMediaType: () =>
    new PublicApiError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Le corps de la requête doit être au format JSON.',
    ),
  passwordPolicy: (message: string) =>
    new PublicApiError(422, 'PASSWORD_POLICY_VIOLATION', message),
  validation: (fields: readonly string[]) =>
    new PublicApiError(
      400,
      'VALIDATION_FAILED',
      fields.length > 0 ? `Champs invalides : ${fields.join(', ')}.` : 'Requête invalide.',
    ),
  tooManyRequests: (retryAfterSeconds: number) =>
    new PublicApiError(429, 'TOO_MANY_REQUESTS', 'Trop de tentatives. Réessayez plus tard.', {
      'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
    }),
  mfaCodeInvalid: () => new PublicApiError(401, 'MFA_CODE_INVALID', 'Code invalide ou expiré.'),
  challengeInvalid: () =>
    new PublicApiError(
      401,
      'MFA_CHALLENGE_INVALID',
      'Votre tentative de connexion a expiré. Reconnectez-vous.',
    ),
  currentPasswordInvalid: () =>
    new PublicApiError(400, 'CURRENT_PASSWORD_INVALID', 'Le mot de passe actuel est incorrect.'),
  mfaAlreadyEnabled: () =>
    new PublicApiError(409, 'MFA_ALREADY_ENABLED', 'La double authentification est déjà activée.'),
};
