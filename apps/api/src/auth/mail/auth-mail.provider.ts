export interface AuthMailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Transport for authentication mail only (verification, password reset,
 * security notices). It is not the future business notification system.
 */
export interface AuthMailProvider {
  send(message: AuthMailMessage): Promise<void>;
}

export const AUTH_MAIL_PROVIDER = Symbol('AUTH_MAIL_PROVIDER');
