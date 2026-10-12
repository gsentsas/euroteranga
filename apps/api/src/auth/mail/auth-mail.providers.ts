import type { ApiEnv } from '@euroteranga/config';
import type { Logger } from '@euroteranga/logger';
import { createTransport, type Transporter } from 'nodemailer';
import type { AuthMailMessage, AuthMailProvider } from './auth-mail.provider.js';

/** SMTP delivery (nodemailer). Credentials come from the environment only. */
export class SmtpAuthMailProvider implements AuthMailProvider {
  private readonly transporter: Transporter;

  constructor(
    env: ApiEnv,
    private readonly from: string,
  ) {
    const deployed = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
    this.transporter = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      // Outside local development, refuse to send over an unencrypted channel.
      requireTLS: deployed && !env.SMTP_SECURE,
      ...(env.SMTP_USER && env.SMTP_PASSWORD
        ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
        : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: AuthMailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

/**
 * Drops messages (local/CI without a mail catcher; refused in production by
 * configuration). Logs that a message was suppressed, never its content.
 */
export class DisabledAuthMailProvider implements AuthMailProvider {
  constructor(private readonly logger: Logger) {}

  send(message: AuthMailMessage): Promise<void> {
    this.logger.info('auth mail suppressed (AUTH_MAIL_PROVIDER=disabled)', {
      mail_subject: message.subject,
    });
    return Promise.resolve();
  }
}

export function createAuthMailProvider(env: ApiEnv, logger: Logger): AuthMailProvider {
  if (env.AUTH_MAIL_PROVIDER === 'smtp' && env.AUTH_EMAIL_FROM) {
    return new SmtpAuthMailProvider(env, env.AUTH_EMAIL_FROM);
  }
  return new DisabledAuthMailProvider(logger);
}
