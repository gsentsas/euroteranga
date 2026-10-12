export type Realm = 'customer' | 'staff' | 'crew';

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface MeResponse {
  id: string;
  realm: Realm;
  email: string;
  emailVerified: boolean;
}

export interface SessionInfo {
  createdAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export type StaffMfaProof = { code: string } | { recoveryCode: string };

export interface AccessInfo {
  roles: string[];
  permissions: string[];
}

export interface AdminRole {
  key: string;
  name: string;
  description: string;
  realm: string;
  privileged: boolean;
  system: boolean;
  permissions: string[];
}

export interface AdminIdentity {
  id: string;
  realm: string;
  email: string;
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  emailVerifiedAt: string | null;
  roles: string[];
  mfaEnabled: boolean;
  createdAt: string;
}

export interface AdminAuditEvent {
  id: string;
  occurredAt: string;
  actor: { id: string; email: string; realm: string } | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface NetworkCountry {
  id: string;
  iso2: string;
  iso3: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkStop {
  id: string;
  code: string;
  name: string;
  countryId: string;
  locality: string;
  latitude: number;
  longitude: number;
  timezone: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  country: NetworkCountry;
}

export type NetworkCheckpointType = 'BORDER' | 'FERRY_TERMINAL' | 'PORT' | 'TECHNICAL';

export interface NetworkCheckpoint {
  id: string;
  code: string;
  name: string;
  countryId: string;
  type: NetworkCheckpointType;
  locality: string;
  latitude: number;
  longitude: number;
  timezone: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  country: NetworkCountry;
}

export type NetworkRouteVersionStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

export interface NetworkRoute {
  id: string;
  code: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  versions: NetworkRouteVersionSummary[];
}

export interface NetworkRouteWaypoint {
  id: string;
  routeVersionId: string;
  sequence: number;
  kind: 'STOP' | 'CHECKPOINT';
  stopId: string | null;
  checkpointId: string | null;
  boardingAllowed: boolean;
  alightingAllowed: boolean;
  stop: NetworkStop | null;
  checkpoint: NetworkCheckpoint | null;
}

export interface NetworkRouteVersion {
  id: string;
  routeId: string;
  version: number;
  status: NetworkRouteVersionStatus;
  publishedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  waypoints: NetworkRouteWaypoint[];
}

export type NetworkRouteVersionSummary = Omit<NetworkRouteVersion, 'waypoints'>;

export interface NetworkRouteDetail extends Omit<NetworkRoute, 'versions'> {
  versions: NetworkRouteVersion[];
}

export interface NetworkWaypointReplacement {
  routeVersionId: string;
  waypoints: NetworkRouteWaypoint[];
}

export interface NetworkListOptions {
  cursor?: string;
  limit?: number;
}

export interface NetworkCountryInput {
  iso2: string;
  iso3: string;
  name: string;
  active: boolean;
}

export interface NetworkCountryUpdate {
  iso2?: string;
  iso3?: string;
  name?: string;
  active?: boolean;
}

export interface NetworkPlaceInput {
  code: string;
  name: string;
  countryId: string;
  locality: string;
  latitude: number;
  longitude: number;
  timezone: string;
  active: boolean;
}

export interface NetworkPlaceUpdate {
  code?: string;
  name?: string;
  countryId?: string;
  locality?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  active?: boolean;
}

export interface NetworkCheckpointInput extends NetworkPlaceInput {
  type: NetworkCheckpointType;
}

export interface NetworkCheckpointUpdate extends NetworkPlaceUpdate {
  type?: NetworkCheckpointType;
}

export interface NetworkRouteInput {
  code: string;
  name: string;
  active: boolean;
}

export interface NetworkRouteUpdate {
  code?: string;
  name?: string;
  active?: boolean;
}

export type NetworkWaypointInput =
  | {
      kind: 'STOP';
      stopId: string;
      boardingAllowed: boolean;
      alightingAllowed: boolean;
    }
  | { kind: 'CHECKPOINT'; checkpointId: string };

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

const NETWORK_ERROR: ApiError = {
  status: 0,
  code: 'NETWORK_ERROR',
  message: 'Service indisponible. Vérifiez votre connexion et réessayez.',
};

const UNEXPECTED_ERROR = 'Une erreur est survenue. Réessayez plus tard.';

/**
 * Browser client for the authentication API.
 *
 * - The session lives in an HttpOnly cookie set by the API; this client never
 *   sees, stores or forwards it (`credentials: 'include'` lets the browser do it).
 * - CSRF tokens are fetched right before each authenticated mutation and kept
 *   in memory only — never in localStorage, sessionStorage or IndexedDB.
 * - Whether the user is signed in is always asked to the server (`me`).
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export function createAuthClient(baseUrl: string) {
  const root = stripTrailingSlashes(baseUrl);

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; csrf?: string } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (options.csrf) headers['X-CSRF-Token'] = options.csrf;

    let response: Response;
    try {
      response = await fetch(`${root}${path}`, {
        method,
        headers,
        credentials: 'include',
        cache: 'no-store',
        ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
      });
    } catch {
      return { ok: false, error: NETWORK_ERROR };
    }

    const payload: unknown =
      response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (response.ok) return { ok: true, data: payload as T };

    const body = (payload ?? {}) as Partial<ApiError>;
    return {
      ok: false,
      error: {
        status: response.status,
        code: typeof body.code === 'string' ? body.code : 'UNKNOWN_ERROR',
        message: typeof body.message === 'string' ? body.message : UNEXPECTED_ERROR,
      },
    };
  }

  async function withCsrf<T>(
    realm: Realm,
    path: string,
    body: unknown = {},
  ): Promise<ApiResult<T>> {
    const csrf = await call<{ csrfToken: string }>('GET', `/v1/auth/${realm}/csrf`);
    if (!csrf.ok) return csrf;
    return call<T>('POST', path, { body, csrf: csrf.data.csrfToken });
  }

  return {
    login: (realm: Realm, email: string, password: string) =>
      call<{ status: 'AUTHENTICATED' | 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED' }>(
        'POST',
        `/v1/auth/${realm}/login`,
        { body: { email, password } },
      ),
    me: (realm: Realm) => call<MeResponse>('GET', `/v1/auth/${realm}/me`),
    session: (realm: Realm) => call<SessionInfo>('GET', `/v1/auth/${realm}/session`),
    /** Idempotent: succeeds even when the session is already gone. */
    async logout(realm: Realm): Promise<ApiResult<void>> {
      const result = await withCsrf<void>(realm, `/v1/auth/${realm}/logout`);
      if (!result.ok && result.error.status === 401) {
        return call<void>('POST', `/v1/auth/${realm}/logout`);
      }
      return result;
    },
    revokeAllSessions: (realm: Realm) =>
      withCsrf<void>(realm, `/v1/auth/${realm}/sessions/revoke-all`),
    changePassword: (realm: Realm, currentPassword: string, newPassword: string) =>
      withCsrf<{ status: 'PASSWORD_CHANGED' }>(realm, `/v1/auth/${realm}/password/change`, {
        currentPassword,
        newPassword,
      }),

    register: (email: string, password: string) =>
      call<{ message: string }>('POST', '/v1/auth/customer/register', {
        body: { email, password },
      }),
    verifyEmail: (token: string, password: string) =>
      call<{ status: 'EMAIL_VERIFIED' }>('POST', '/v1/auth/customer/verify-email', {
        body: { token, password },
      }),
    resendVerification: (email: string) =>
      call<{ message: string }>('POST', '/v1/auth/customer/resend-verification', {
        body: { email },
      }),
    forgotPassword: (email: string) =>
      call<{ message: string }>('POST', '/v1/auth/customer/password/forgot', { body: { email } }),
    resetPassword: (token: string, newPassword: string) =>
      call<{ status: 'PASSWORD_RESET' }>('POST', '/v1/auth/customer/password/reset', {
        body: { token, newPassword },
      }),

    staffMfaVerify: (proof: StaffMfaProof) =>
      call<{ status: 'AUTHENTICATED' }>('POST', '/v1/auth/staff/mfa/verify', { body: proof }),
    staffEnrollmentStart: () =>
      call<{ otpauthUri: string; secret: string }>('POST', '/v1/auth/staff/mfa/enrollment/start'),
    staffEnrollmentConfirm: (code: string) =>
      call<{ status: 'AUTHENTICATED'; recoveryCodes: string[] }>(
        'POST',
        '/v1/auth/staff/mfa/enrollment/confirm',
        { body: { code } },
      ),

    acceptStaffInvitation: (token: string, newPassword: string) =>
      call<{ status: 'STAFF_INVITATION_ACCEPTED' }>('POST', '/v1/auth/staff/invitation/accept', {
        body: { token, newPassword },
      }),

    /**
     * Administration API (STAFF session). Permissions returned by `access`
     * are for display only: the API re-checks every call.
     */
    admin: {
      access: () => call<AccessInfo>('GET', '/v1/admin/access/me'),
      roles: () => call<AdminRole[]>('GET', '/v1/admin/roles'),
      identities: (options: { realm: 'staff' | 'crew'; cursor?: string; limit?: number }) =>
        call<Page<AdminIdentity>>(
          'GET',
          `/v1/admin/identities?${query({ realm: options.realm, cursor: options.cursor, limit: options.limit })}`,
        ),
      audit: (options: { cursor?: string; limit?: number } = {}) =>
        call<Page<AdminAuditEvent>>('GET', `/v1/admin/audit?${query(options)}`),
      grantRole: (identityId: string, roleKey: string, reason?: string) =>
        withCsrf<unknown>('staff', `/v1/admin/identities/${encodeURIComponent(identityId)}/roles`, {
          roleKey,
          ...(reason ? { reason } : {}),
        }),
      revokeRole: (identityId: string, roleKey: string, reason?: string) =>
        withCsrf<void>(
          'staff',
          `/v1/admin/identities/${encodeURIComponent(identityId)}/roles/revoke`,
          {
            roleKey,
            ...(reason ? { reason } : {}),
          },
        ),
      setStatus: (
        identityId: string,
        status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED',
        reason?: string,
      ) =>
        withCsrf<{ status: string }>(
          'staff',
          `/v1/admin/identities/${encodeURIComponent(identityId)}/status`,
          {
            status,
            ...(reason ? { reason } : {}),
          },
        ),
      revokeSessions: (identityId: string) =>
        withCsrf<void>(
          'staff',
          `/v1/admin/identities/${encodeURIComponent(identityId)}/sessions/revoke-all`,
        ),
      inviteStaff: (email: string, roleKey: string) =>
        withCsrf<{ status: string; identityId: string; expiresAt: string }>(
          'staff',
          '/v1/admin/staff/invitations',
          {
            email,
            roleKey,
          },
        ),
      authorizeMfaEnrollment: (identityId: string) =>
        withCsrf<{ expiresAt: string }>(
          'staff',
          `/v1/admin/staff/${encodeURIComponent(identityId)}/mfa/enrollment-authorization`,
        ),
      network: {
        countries: (options: NetworkListOptions = {}) =>
          call<Page<NetworkCountry>>(
            'GET',
            `/v1/admin/network/countries?${query({ cursor: options.cursor, limit: options.limit })}`,
          ),
        createCountry: (input: NetworkCountryInput) =>
          withCsrf<NetworkCountry>('staff', '/v1/admin/network/countries', input),
        updateCountry: (countryId: string, input: NetworkCountryUpdate) =>
          withCsrf<NetworkCountry>(
            'staff',
            `/v1/admin/network/countries/${encodeURIComponent(countryId)}`,
            input,
          ),
        stops: (options: NetworkListOptions = {}) =>
          call<Page<NetworkStop>>(
            'GET',
            `/v1/admin/network/stops?${query({ cursor: options.cursor, limit: options.limit })}`,
          ),
        createStop: (input: NetworkPlaceInput) =>
          withCsrf<NetworkStop>('staff', '/v1/admin/network/stops', input),
        updateStop: (stopId: string, input: NetworkPlaceUpdate) =>
          withCsrf<NetworkStop>(
            'staff',
            `/v1/admin/network/stops/${encodeURIComponent(stopId)}`,
            input,
          ),
        checkpoints: (options: NetworkListOptions = {}) =>
          call<Page<NetworkCheckpoint>>(
            'GET',
            `/v1/admin/network/checkpoints?${query({ cursor: options.cursor, limit: options.limit })}`,
          ),
        createCheckpoint: (input: NetworkCheckpointInput) =>
          withCsrf<NetworkCheckpoint>('staff', '/v1/admin/network/checkpoints', input),
        updateCheckpoint: (checkpointId: string, input: NetworkCheckpointUpdate) =>
          withCsrf<NetworkCheckpoint>(
            'staff',
            `/v1/admin/network/checkpoints/${encodeURIComponent(checkpointId)}`,
            input,
          ),
        routes: (options: NetworkListOptions = {}) =>
          call<Page<NetworkRoute>>(
            'GET',
            `/v1/admin/network/routes?${query({ cursor: options.cursor, limit: options.limit })}`,
          ),
        route: (routeId: string) =>
          call<NetworkRouteDetail>(
            'GET',
            `/v1/admin/network/routes/${encodeURIComponent(routeId)}`,
          ),
        createRoute: (input: NetworkRouteInput) =>
          withCsrf<NetworkRoute>('staff', '/v1/admin/network/routes', input),
        updateRoute: (routeId: string, input: NetworkRouteUpdate) =>
          withCsrf<NetworkRoute>(
            'staff',
            `/v1/admin/network/routes/${encodeURIComponent(routeId)}`,
            input,
          ),
        createVersion: (routeId: string) =>
          withCsrf<NetworkWaypointReplacement>(
            'staff',
            `/v1/admin/network/routes/${encodeURIComponent(routeId)}/versions`,
          ),
        replaceWaypoints: (routeId: string, versionId: string, waypoints: NetworkWaypointInput[]) =>
          withCsrf<NetworkRouteVersion>(
            'staff',
            `/v1/admin/network/routes/${encodeURIComponent(routeId)}/versions/${encodeURIComponent(versionId)}/waypoints`,
            { waypoints },
          ),
        publishVersion: (routeId: string, versionId: string) =>
          withCsrf<NetworkRouteVersion>(
            'staff',
            `/v1/admin/network/routes/${encodeURIComponent(routeId)}/versions/${encodeURIComponent(versionId)}/publish`,
          ),
      },
    },
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
