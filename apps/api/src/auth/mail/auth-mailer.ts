import { Inject, Injectable } from '@nestjs/common';
import { AUTH_CONFIG, type AuthConfig } from '../auth.config.js';
import { SecurityEventLogger } from '../security-log/security-events.js';
import {
  AUTH_MAIL_PROVIDER,
  type AuthMailMessage,
  type AuthMailProvider,
} from './auth-mail.provider.js';

export type AuthMailKind =
  'email-verification' | 'password-reset' | 'account-exists' | 'password-changed';

/**
 * Composes and dispatches authentication mail.
 *
 * Delivery is deliberately asynchronous (not awaited by the HTTP request):
 * response time and status do not depend on whether a mail is sent, which
 * would otherwise reveal whether an account exists, and an SMTP outage never
 * rolls back or corrupts the database. A lost mail is recoverable by the user
 * (resend verification / request a new reset link); failures are logged
 * without the message content. See docs/security/authentication.md.
 *
 * Links put the token in the URL fragment (#token=...), which browsers do not
 * send to servers, proxies or Referer headers.
 */
@Injectable()
export class AuthMailer {
  constructor(
    @Inject(AUTH_MAIL_PROVIDER) private readonly provider: AuthMailProvider,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly securityLog: SecurityEventLogger,
  ) {}

  sendEmailVerification(to: string, token: string, ttlMs: number): void {
    const link = `${this.config.clientPublicUrl}/verification-email#token=${token}`;
    this.dispatch('email-verification', {
      to,
      subject: 'EURO TERANGA — confirmez votre adresse e-mail',
      text: [
        'Bonjour,',
        '',
        'Pour activer votre compte EURO TERANGA, ouvrez le lien ci-dessous puis confirmez votre mot de passe :',
        link,
        '',
        `Ce lien est valable ${Math.round(ttlMs / 3_600_000)} heures et ne peut être utilisé qu'une fois.`,
        "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.",
      ].join('\n'),
    });
  }

  sendPasswordReset(to: string, token: string, ttlMs: number): void {
    const link = `${this.config.clientPublicUrl}/reinitialiser-mot-de-passe#token=${token}`;
    this.dispatch('password-reset', {
      to,
      subject: 'EURO TERANGA — réinitialisation du mot de passe',
      text: [
        'Bonjour,',
        '',
        'Pour choisir un nouveau mot de passe, ouvrez le lien ci-dessous :',
        link,
        '',
        `Ce lien est valable ${Math.round(ttlMs / 60_000)} minutes et ne peut être utilisé qu'une fois.`,
        "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.",
      ].join('\n'),
    });
  }

  sendAccountExists(to: string): void {
    this.dispatch('account-exists', {
      to,
      subject: 'EURO TERANGA — tentative de création de compte',
      text: [
        'Bonjour,',
        '',
        'Une demande de création de compte a été faite avec votre adresse, qui possède déjà un compte EURO TERANGA.',
        `Pour vous connecter : ${this.config.clientPublicUrl}/connexion`,
        `Mot de passe oublié : ${this.config.clientPublicUrl}/mot-de-passe-oublie`,
        '',
        "Si vous n'êtes pas à l'origine de cette demande, aucune action n'est nécessaire.",
      ].join('\n'),
    });
  }

  sendPasswordChanged(to: string): void {
    this.dispatch('password-changed', {
      to,
      subject: 'EURO TERANGA — votre mot de passe a été modifié',
      text: [
        'Bonjour,',
        '',
        'Le mot de passe de votre compte EURO TERANGA vient d’être modifié et toutes vos sessions ont été fermées.',
        `Si vous n'êtes pas à l'origine de ce changement, réinitialisez-le immédiatement : ${this.config.clientPublicUrl}/mot-de-passe-oublie`,
      ].join('\n'),
    });
  }

  private dispatch(kind: AuthMailKind, message: AuthMailMessage): void {
    void this.provider.send(message).catch((error: unknown) => {
      this.securityLog.record('AUTH_MAIL_DELIVERY_FAILED', {
        mail_kind: kind,
        error_name: error instanceof Error ? error.name : 'unknown',
      });
    });
  }
}
