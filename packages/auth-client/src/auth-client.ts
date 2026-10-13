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

export type FareTableVersionStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

/** Fare table version as embedded in trips. */
export interface AssignedFareTableVersion {
  id: string;
  version: number;
  status: FareTableVersionStatus;
  publishedAt: string | null;
  retiredAt: string | null;
  routeVersionId: string;
  fareTable: {
    id: string;
    code: string;
    name: string;
    currencyCode: string;
    currencyMinorUnit: number;
    active: boolean;
  };
  /** Number of priced origin/destination pairs. */
  entryCount: number;
}

export type SeatMapVersionStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

/** Physical kind of a cell; an absent coordinate is an empty area. */
export type SeatMapCellKind = 'SEAT' | 'AISLE' | 'DRIVER' | 'DOOR' | 'TOILET' | 'STAIRS' | 'OTHER';

/** Seat-map version as embedded in vehicles and trips (capacity computed). */
export interface AssignedSeatMapVersion {
  id: string;
  version: number;
  status: SeatMapVersionStatus;
  publishedAt: string | null;
  retiredAt: string | null;
  seatMap: { id: string; code: string; name: string; active: boolean };
  /** Number of SEAT cells. */
  seatCount: number;
}

export type VehicleStatus = 'PLANNED' | 'ACTIVE' | 'OUT_OF_SERVICE' | 'RETIRED';

export interface AdminVehicle {
  id: string;
  code: string;
  vin: string | null;
  registrationPlate: string | null;
  registrationCountryId: string | null;
  registrationCountry: {
    id: string;
    iso2: string;
    iso3: string;
    name: string;
    active: boolean;
  } | null;
  manufacturer: string;
  model: string;
  modelYear: number | null;
  status: VehicleStatus;
  statusChangedAt: string | null;
  retiredAt: string | null;
  /** Physical seat map currently configured. */
  seatMapVersionId: string | null;
  seatMapVersion: AssignedSeatMapVersion | null;
  createdAt: string;
  updatedAt: string;
}

/** One status change, read from the audit trail (no actor identity). */
export interface VehicleStatusHistoryEntry {
  occurredAt: string;
  from: VehicleStatus | null;
  to: VehicleStatus | null;
  reason: string | null;
}

export interface AdminVehicleDetail extends AdminVehicle {
  statusHistory: VehicleStatusHistoryEntry[];
}

export interface VehicleListOptions {
  cursor?: string;
  limit?: number;
  status?: VehicleStatus;
}

export interface VehicleCreateInput {
  code: string;
  vin?: string | null;
  registrationPlate?: string | null;
  registrationCountryId?: string | null;
  manufacturer: string;
  model: string;
  modelYear?: number | null;
}

/** Administrative data only: the status changes through changeVehicleStatus. */
export type VehicleUpdateInput = Partial<VehicleCreateInput>;

export interface VehicleStatusTransitionInput {
  status: Exclude<VehicleStatus, 'PLANNED'>;
  reason: string;
  /** Status the decision was based on; the API refuses the change if it moved. */
  expectedStatus?: VehicleStatus;
}

export type TripStatus = 'DRAFT' | 'SCHEDULED' | 'CANCELLED';

export interface AdminTripSummary {
  id: string;
  reference: string;
  routeVersionId: string;
  vehicleId: string | null;
  status: TripStatus;
  /** UTC instants (ISO 8601). */
  plannedDepartureAt: string | null;
  plannedArrivalAt: string | null;
  scheduledAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  routeVersion: {
    id: string;
    version: number;
    status: NetworkRouteVersionStatus;
    publishedAt: string | null;
    retiredAt: string | null;
    route: { id: string; code: string; name: string };
  };
  vehicle: {
    id: string;
    code: string;
    status: VehicleStatus;
    manufacturer: string;
    model: string;
    /** The vehicle's current configuration (may differ from the trip's later). */
    seatMapVersion: AssignedSeatMapVersion | null;
  } | null;
  /** Historical seat map of the trip; frozen once SCHEDULED. */
  seatMapVersionId: string | null;
  seatMapVersion: AssignedSeatMapVersion | null;
  /** Historical pricing of the trip; frozen once SCHEDULED. */
  fareTableVersionId: string | null;
  fareTableVersion: AssignedFareTableVersion | null;
}

export interface AdminTripPlace {
  id: string;
  code: string;
  name: string;
  /** IANA timezone, for presentation only (times are stored in UTC). */
  timezone: string;
}

export interface AdminTripRouteWaypoint {
  id: string;
  sequence: number;
  boardingAllowed: boolean;
  alightingAllowed: boolean;
  stop: AdminTripPlace | null;
  checkpoint: (AdminTripPlace & { type: NetworkCheckpointType }) | null;
}

export interface AdminTripTiming {
  id: string;
  routeWaypointId: string;
  sequence: number;
  plannedArrivalAt: string | null;
  plannedDepartureAt: string | null;
}

/** Business history read from the audit trail (no actor identity). */
export interface TripHistoryEntry {
  occurredAt: string;
  action: string;
  reason: string | null;
  fromStatus: TripStatus | null;
  toStatus: TripStatus | null;
  fromVehicleCode: string | null;
  toVehicleCode: string | null;
  fromSeatMap: string | null;
  toSeatMap: string | null;
  fromFareTable: string | null;
  toFareTable: string | null;
}

export interface AdminTrip extends Omit<AdminTripSummary, 'routeVersion'> {
  routeVersion: AdminTripSummary['routeVersion'] & { waypoints: AdminTripRouteWaypoint[] };
  timings: AdminTripTiming[];
  history: TripHistoryEntry[];
}

export interface TripListOptions {
  cursor?: string;
  limit?: number;
  status?: TripStatus;
  routeId?: string;
  routeVersionId?: string;
  /** ISO 8601 with offset. */
  departureFrom?: string;
  departureTo?: string;
}

export interface TripCreateInput {
  reference: string;
  routeVersionId: string;
  vehicleId?: string | null;
}

export interface TripTimetableInput {
  /** One entry per route waypoint; ISO 8601 instants with an explicit offset. */
  timings: Array<{
    routeWaypointId: string;
    plannedArrivalAt: string | null;
    plannedDepartureAt: string | null;
  }>;
}

export interface TripCancelInput {
  reason: string;
  expectedStatus?: TripStatus;
}

export interface TripVehicleInput {
  /** null removes the vehicle. */
  vehicleId: string | null;
  /** Vehicle the decision was based on (null: none); refused if it moved. */
  expectedVehicleId?: string | null;
  /** Required once the trip is SCHEDULED. */
  reason?: string;
}

export interface AdminSeatMapCell {
  id: string;
  deck: number;
  row: number;
  column: number;
  kind: SeatMapCellKind;
  seatLabel: string | null;
}

export interface AdminSeatMapVersionSummary {
  id: string;
  seatMapId: string;
  version: number;
  status: SeatMapVersionStatus;
  publishedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Number of SEAT cells (never stored). */
  seatCount: number;
}

export interface AdminSeatMapVersion extends AdminSeatMapVersionSummary {
  cells: AdminSeatMapCell[];
  /** Vehicles currently configured with this version. */
  vehicleCount: number;
  /** Trips carrying this version. */
  tripCount: number;
}

export interface AdminSeatMapSummary {
  id: string;
  code: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  versions: AdminSeatMapVersionSummary[];
}

export interface AdminSeatMap extends Omit<AdminSeatMapSummary, 'versions'> {
  versions: AdminSeatMapVersion[];
}

export interface SeatMapListOptions {
  cursor?: string;
  limit?: number;
  active?: boolean;
}

export interface SeatMapCreateInput {
  code: string;
  name: string;
  active: boolean;
}

export type SeatMapUpdateInput = Partial<SeatMapCreateInput>;

export interface SeatMapCellsInput {
  /** The complete layout of the draft (replaces the previous one). */
  cells: Array<{
    deck: number;
    row: number;
    column: number;
    kind: SeatMapCellKind;
    /** Required for SEAT, absent or null otherwise. */
    seatLabel?: string | null;
  }>;
}

export interface VehicleSeatMapInput {
  /** A PUBLISHED version; null removes the seat map. */
  seatMapVersionId: string | null;
  /** Seat map the decision was based on (null: none); refused if it moved. */
  expectedSeatMapVersionId?: string | null;
}

export type TripSeatMapInput = VehicleSeatMapInput;

export interface AdminFareWaypoint {
  id: string;
  sequence: number;
  boardingAllowed: boolean;
  alightingAllowed: boolean;
  stop: { id: string; code: string; name: string } | null;
  checkpoint: { id: string; code: string; name: string } | null;
}

export interface AdminFareEntry {
  id: string;
  originRouteWaypointId: string;
  destinationRouteWaypointId: string;
  /** Exact amount in the fare table's currency minor unit. */
  amountMinor: number;
}

export interface AdminFareTableVersionSummary {
  id: string;
  fareTableId: string;
  routeVersionId: string;
  version: number;
  status: FareTableVersionStatus;
  publishedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  routeVersion: { id: string; version: number; status: NetworkRouteVersionStatus };
  entryCount: number;
}

export interface AdminFareTableVersion extends Omit<AdminFareTableVersionSummary, 'routeVersion'> {
  routeVersion: {
    id: string;
    version: number;
    status: NetworkRouteVersionStatus;
    waypoints: AdminFareWaypoint[];
  };
  entries: AdminFareEntry[];
  /** Trips priced with this version. */
  tripCount: number;
}

export interface AdminFareTableSummary {
  id: string;
  code: string;
  name: string;
  routeId: string;
  currencyCode: string;
  currencyMinorUnit: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  route: { id: string; code: string; name: string };
  versions: AdminFareTableVersionSummary[];
}

export interface AdminFareTable extends Omit<AdminFareTableSummary, 'route' | 'versions'> {
  route: {
    id: string;
    code: string;
    name: string;
    /** Route versions that have been published (the only priceable ones). */
    versions: Array<{
      id: string;
      version: number;
      status: NetworkRouteVersionStatus;
      publishedAt: string | null;
    }>;
  };
  versions: AdminFareTableVersion[];
}

export interface FareTableListOptions {
  cursor?: string;
  limit?: number;
  active?: boolean;
  routeId?: string;
}

export interface FareTableCreateInput {
  code: string;
  name: string;
  routeId: string;
  /** Three letters, e.g. EUR or XOF. Immutable. */
  currencyCode: string;
  /** 0-3 (EUR 2, XOF 0). Immutable. */
  currencyMinorUnit: number;
  active: boolean;
}

/** Name and active state only: route and currency never change. */
export interface FareTableUpdateInput {
  name?: string;
  active?: boolean;
}

export interface FareTableFaresInput {
  /** The complete (possibly partial) matrix of the draft. */
  fares: Array<{
    originRouteWaypointId: string;
    destinationRouteWaypointId: string;
    amountMinor: number;
  }>;
}

export interface TripFareTableInput {
  /** A PUBLISHED version pricing the trip's route version; null removes it. */
  fareTableVersionId: string | null;
  /** Pricing the decision was based on (null: none); refused if it moved. */
  expectedFareTableVersionId?: string | null;
}

/** Server-side resolution of one base fare (not a booking or a quote). */
export interface ResolvedTripFare {
  tripId: string;
  fareTableId: string;
  fareTableCode: string;
  fareTableVersionId: string;
  fareTableVersion: number;
  fareEntryId: string;
  originRouteWaypointId: string;
  destinationRouteWaypointId: string;
  amountMinor: number;
  currencyCode: string;
  currencyMinorUnit: number;
}

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
          withCsrf<NetworkRouteVersion>(
            'staff',
            `/v1/admin/network/routes/${encodeURIComponent(routeId)}/versions`,
          ),
        replaceWaypoints: (routeId: string, versionId: string, waypoints: NetworkWaypointInput[]) =>
          withCsrf<NetworkWaypointReplacement>(
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
      fleet: {
        vehicles: (options: VehicleListOptions = {}) =>
          call<Page<AdminVehicle>>(
            'GET',
            `/v1/admin/fleet/vehicles?${query({ cursor: options.cursor, limit: options.limit, status: options.status })}`,
          ),
        vehicle: (vehicleId: string) =>
          call<AdminVehicleDetail>(
            'GET',
            `/v1/admin/fleet/vehicles/${encodeURIComponent(vehicleId)}`,
          ),
        createVehicle: (input: VehicleCreateInput) =>
          withCsrf<AdminVehicle>('staff', '/v1/admin/fleet/vehicles', input),
        updateVehicle: (vehicleId: string, input: VehicleUpdateInput) =>
          withCsrf<AdminVehicle>(
            'staff',
            `/v1/admin/fleet/vehicles/${encodeURIComponent(vehicleId)}`,
            input,
          ),
        changeVehicleStatus: (vehicleId: string, input: VehicleStatusTransitionInput) =>
          withCsrf<AdminVehicle>(
            'staff',
            `/v1/admin/fleet/vehicles/${encodeURIComponent(vehicleId)}/status`,
            input,
          ),
        assignVehicleSeatMap: (vehicleId: string, input: VehicleSeatMapInput) =>
          withCsrf<AdminVehicle>(
            'staff',
            `/v1/admin/fleet/vehicles/${encodeURIComponent(vehicleId)}/seat-map`,
            input,
          ),
      },
      trips: {
        trips: (options: TripListOptions = {}) =>
          call<Page<AdminTripSummary>>(
            'GET',
            `/v1/admin/trips?${query({
              cursor: options.cursor,
              limit: options.limit,
              status: options.status,
              routeId: options.routeId,
              routeVersionId: options.routeVersionId,
              departureFrom: options.departureFrom,
              departureTo: options.departureTo,
            })}`,
          ),
        trip: (tripId: string) =>
          call<AdminTrip>('GET', `/v1/admin/trips/${encodeURIComponent(tripId)}`),
        createTrip: (input: TripCreateInput) =>
          withCsrf<AdminTrip>('staff', '/v1/admin/trips', input),
        replaceTimetable: (tripId: string, input: TripTimetableInput) =>
          withCsrf<AdminTrip>(
            'staff',
            `/v1/admin/trips/${encodeURIComponent(tripId)}/timetable`,
            input,
          ),
        scheduleTrip: (tripId: string) =>
          withCsrf<AdminTrip>('staff', `/v1/admin/trips/${encodeURIComponent(tripId)}/schedule`),
        cancelTrip: (tripId: string, input: TripCancelInput) =>
          withCsrf<AdminTrip>(
            'staff',
            `/v1/admin/trips/${encodeURIComponent(tripId)}/cancel`,
            input,
          ),
        assignTripVehicle: (tripId: string, input: TripVehicleInput) =>
          withCsrf<AdminTrip>(
            'staff',
            `/v1/admin/trips/${encodeURIComponent(tripId)}/vehicle`,
            input,
          ),
        assignTripSeatMap: (tripId: string, input: TripSeatMapInput) =>
          withCsrf<AdminTrip>(
            'staff',
            `/v1/admin/trips/${encodeURIComponent(tripId)}/seat-map`,
            input,
          ),
        assignTripFareTable: (tripId: string, input: TripFareTableInput) =>
          withCsrf<AdminTrip>(
            'staff',
            `/v1/admin/trips/${encodeURIComponent(tripId)}/fare-table`,
            input,
          ),
        resolveTripFare: (
          tripId: string,
          originRouteWaypointId: string,
          destinationRouteWaypointId: string,
        ) =>
          call<ResolvedTripFare>(
            'GET',
            `/v1/admin/trips/${encodeURIComponent(tripId)}/fare?${query({
              originRouteWaypointId,
              destinationRouteWaypointId,
            })}`,
          ),
      },
      seatMaps: {
        seatMaps: (options: SeatMapListOptions = {}) =>
          call<Page<AdminSeatMapSummary>>(
            'GET',
            `/v1/admin/seat-maps?${query({
              cursor: options.cursor,
              limit: options.limit,
              active: options.active === undefined ? undefined : String(options.active),
            })}`,
          ),
        seatMap: (seatMapId: string) =>
          call<AdminSeatMap>('GET', `/v1/admin/seat-maps/${encodeURIComponent(seatMapId)}`),
        createSeatMap: (input: SeatMapCreateInput) =>
          withCsrf<AdminSeatMap>('staff', '/v1/admin/seat-maps', input),
        updateSeatMap: (seatMapId: string, input: SeatMapUpdateInput) =>
          withCsrf<AdminSeatMap>(
            'staff',
            `/v1/admin/seat-maps/${encodeURIComponent(seatMapId)}`,
            input,
          ),
        createVersion: (seatMapId: string) =>
          withCsrf<AdminSeatMap>(
            'staff',
            `/v1/admin/seat-maps/${encodeURIComponent(seatMapId)}/versions`,
          ),
        replaceCells: (seatMapId: string, versionId: string, input: SeatMapCellsInput) =>
          withCsrf<AdminSeatMap>(
            'staff',
            `/v1/admin/seat-maps/${encodeURIComponent(seatMapId)}/versions/${encodeURIComponent(versionId)}/cells`,
            input,
          ),
        publishVersion: (seatMapId: string, versionId: string) =>
          withCsrf<AdminSeatMap>(
            'staff',
            `/v1/admin/seat-maps/${encodeURIComponent(seatMapId)}/versions/${encodeURIComponent(versionId)}/publish`,
          ),
      },
      pricing: {
        fareTables: (options: FareTableListOptions = {}) =>
          call<Page<AdminFareTableSummary>>(
            'GET',
            `/v1/admin/pricing/fare-tables?${query({
              cursor: options.cursor,
              limit: options.limit,
              active: options.active === undefined ? undefined : String(options.active),
              routeId: options.routeId,
            })}`,
          ),
        fareTable: (fareTableId: string) =>
          call<AdminFareTable>(
            'GET',
            `/v1/admin/pricing/fare-tables/${encodeURIComponent(fareTableId)}`,
          ),
        createFareTable: (input: FareTableCreateInput) =>
          withCsrf<AdminFareTable>('staff', '/v1/admin/pricing/fare-tables', input),
        updateFareTable: (fareTableId: string, input: FareTableUpdateInput) =>
          withCsrf<AdminFareTable>(
            'staff',
            `/v1/admin/pricing/fare-tables/${encodeURIComponent(fareTableId)}`,
            input,
          ),
        createVersion: (fareTableId: string, routeVersionId: string) =>
          withCsrf<AdminFareTable>(
            'staff',
            `/v1/admin/pricing/fare-tables/${encodeURIComponent(fareTableId)}/versions`,
            { routeVersionId },
          ),
        replaceFares: (fareTableId: string, versionId: string, input: FareTableFaresInput) =>
          withCsrf<AdminFareTable>(
            'staff',
            `/v1/admin/pricing/fare-tables/${encodeURIComponent(fareTableId)}/versions/${encodeURIComponent(versionId)}/fares`,
            input,
          ),
        publishVersion: (fareTableId: string, versionId: string) =>
          withCsrf<AdminFareTable>(
            'staff',
            `/v1/admin/pricing/fare-tables/${encodeURIComponent(fareTableId)}/versions/${encodeURIComponent(versionId)}/publish`,
          ),
      },
    },
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
