import type { ApiEnv } from '@euroteranga/config';
import type { Logger } from '@euroteranga/logger';
import { Module, type DynamicModule } from '@nestjs/common';
import { API_ENV, API_LOGGER } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AUTH_CONFIG, buildAuthConfig } from './auth.config.js';
import { CustomerAuthController } from './controllers/customer-auth.controller.js';
import { RealmAuthController } from './controllers/realm-auth.controller.js';
import { StaffMfaController } from './controllers/staff-mfa.controller.js';
import { CsrfService } from './csrf/csrf.service.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from './http/auth.guards.js';
import { IdentityQueries } from './identity/identity.queries.js';
import { LoginService } from './login/login.service.js';
import { AUTH_MAIL_PROVIDER, type AuthMailProvider } from './mail/auth-mail.provider.js';
import { createAuthMailProvider } from './mail/auth-mail.providers.js';
import { AuthMailer } from './mail/auth-mailer.js';
import { ChallengeService } from './mfa/challenge.service.js';
import { StaffMfaService } from './mfa/staff-mfa.service.js';
import { RateLimitService } from './rate-limit/rate-limit.service.js';
import { PasswordChangeService } from './recovery/password-change.service.js';
import { PasswordRecoveryService } from './recovery/password-recovery.service.js';
import { RegistrationService } from './registration/registration.service.js';
import { SecurityEventLogger } from './security-log/security-events.js';
import { AuthCookies } from './session/auth-cookies.js';
import { SessionService } from './session/session.service.js';

export interface AuthModuleOptions {
  /** Replaces the configured mail transport (tests use an in-memory fake). */
  mailProvider?: AuthMailProvider;
}

/** Identity and authentication (realms CUSTOMER, STAFF, CREW). No RBAC here. */
@Module({})
export class AuthModule {
  static register(options: AuthModuleOptions = {}): DynamicModule {
    return {
      module: AuthModule,
      imports: [DatabaseModule],
      controllers: [CustomerAuthController, RealmAuthController, StaffMfaController],
      providers: [
        {
          provide: AUTH_CONFIG,
          inject: [API_ENV],
          useFactory: (env: ApiEnv) => buildAuthConfig(env),
        },
        options.mailProvider
          ? { provide: AUTH_MAIL_PROVIDER, useValue: options.mailProvider }
          : {
              provide: AUTH_MAIL_PROVIDER,
              inject: [API_ENV, API_LOGGER],
              useFactory: (env: ApiEnv, logger: Logger) => createAuthMailProvider(env, logger),
            },
        SecurityEventLogger,
        RateLimitService,
        SessionService,
        AuthCookies,
        CsrfService,
        ChallengeService,
        AuthMailer,
        IdentityQueries,
        LoginService,
        RegistrationService,
        PasswordRecoveryService,
        PasswordChangeService,
        StaffMfaService,
        AuthRequestGuard,
        SessionGuard,
        CsrfGuard,
      ],
      exports: [AUTH_CONFIG, SessionService],
    };
  }
}
