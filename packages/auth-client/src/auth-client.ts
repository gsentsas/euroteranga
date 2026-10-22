export type Realm = 'customer' | 'staff' | 'crew';

export interface ApiError {
  status: number;
  code: string;
  message: string;
  /** Server-built stable codes, e.g. check-in blockers (PR-14). */
  details?: ApiErrorDetails;
}

export interface ApiErrorDetails {
  blockers?: CheckInBlocker[];
  /** CMS-2: fields of a content document refused by the content model. */
  issues?: ContentIssue[];
  /** MEDIA-1: the image already in the library (MEDIA_DUPLICATE). */
  mediaId?: string;
  /** MEDIA-1: contents still showing an image (MEDIA_IN_USE). */
  usages?: MediaUsage[];
}

export interface ContentIssue {
  /** Dotted path in the document, e.g. `blocks.2.items.0.title`. */
  path: string;
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

export type NetworkTerangaStopKind =
  'BREAK' | 'MEAL' | 'SHOWER' | 'REST' | 'OVERNIGHT' | 'FUEL' | 'BORDER' | 'FERRY' | 'TECHNICAL';

export type NetworkTerangaFacility = 'RESTROOM' | 'SHOWER' | 'FOOD' | 'SECURE_PARKING' | 'FUEL';

export interface NetworkCheckpoint {
  id: string;
  code: string;
  name: string;
  countryId: string;
  type: NetworkCheckpointType;
  terangaKind: NetworkTerangaStopKind;
  travellerVisible: boolean;
  suggestedDwellMinutes: number | null;
  facilities: NetworkTerangaFacility[];
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
  terangaKind?: NetworkTerangaStopKind;
  travellerVisible?: boolean;
  suggestedDwellMinutes?: number | null;
  facilities?: NetworkTerangaFacility[];
}

export interface NetworkCheckpointUpdate extends NetworkPlaceUpdate {
  type?: NetworkCheckpointType;
  terangaKind?: NetworkTerangaStopKind;
  travellerVisible?: boolean;
  suggestedDwellMinutes?: number | null;
  facilities?: NetworkTerangaFacility[];
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

/**
 * Identity of a trip's fare table version: all a trip.read holder without
 * pricing.read receives.
 */
export interface TripFareTableIdentity {
  id: string;
  version: number;
  fareTable: { code: string; currencyCode: string };
  /** Number of priced origin/destination pairs. */
  entryCount: number;
}

/** Fare table version as embedded in trips, for pricing.read holders. */
export interface AssignedFareTableVersion extends TripFareTableIdentity {
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
}

/** True when the caller received the full fare-table summary (pricing.read). */
export function hasFareTableDetails(
  version: AssignedFareTableVersion | TripFareTableIdentity,
): version is AssignedFareTableVersion {
  return 'status' in version;
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

export type VehicleRole = 'PASSENGER_COACH' | 'CARGO_SUPPORT' | 'MIXED';

/** On-board equipment, maintained by the fleet team and shown on the website. */
export type VehicleAmenity =
  | 'AIR_CONDITIONING'
  | 'RECLINING_SEATS'
  | 'USB_CHARGING'
  | 'WIFI'
  | 'TOILET'
  | 'ENTERTAINMENT'
  | 'WHEELCHAIR_ACCESS';

export type VehicleMediaKind =
  'EXTERIOR' | 'INTERIOR' | 'SEATS' | 'LUGGAGE_HOLD' | 'EQUIPMENT' | 'CABIN' | 'OTHER';

export interface VehicleGalleryMedia {
  id: string;
  mediaId: string;
  kind: VehicleMediaKind | null;
  position: number;
  createdAt: string;
  media: PublicMedia;
}

export interface AdminVehicle {
  id: string;
  code: string;
  /** Operational name used by the teams (e.g. "Teranga 01"). */
  name: string | null;
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
  /** Operational purpose. CARGO_SUPPORT is excluded from the public coach catalogue. */
  role: VehicleRole;
  /** Useful baggage/freight load; null together with cargoVolumeLiters when unconfigured. */
  payloadCapacityKg: number | null;
  /** Exact useful volume in litres (1000 L = 1 m³). */
  cargoVolumeLiters: number | null;
  /** Distinct, in the canonical order of VehicleAmenity. */
  amenities: VehicleAmenity[];
  /** Active MEDIA-1 image selected for public presentation. */
  primaryMedia: PublicMedia | null;
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
  mediaGallery: VehicleGalleryMedia[];
}

export interface VehicleListOptions {
  cursor?: string;
  limit?: number;
  status?: VehicleStatus;
  role?: VehicleRole;
}

export interface VehicleCreateInput {
  code: string;
  name?: string | null;
  vin?: string | null;
  registrationPlate?: string | null;
  registrationCountryId?: string | null;
  manufacturer: string;
  model: string;
  modelYear?: number | null;
  role?: VehicleRole;
  /** Must be sent together with cargoVolumeLiters when changed. */
  payloadCapacityKg?: number | null;
  /** Must be sent together with payloadCapacityKg when changed. */
  cargoVolumeLiters?: number | null;
  /** Replaces the whole list; duplicates are ignored. */
  amenities?: VehicleAmenity[];
}

/** Administrative data only: the status changes through changeVehicleStatus. */
export type VehicleUpdateInput = Partial<VehicleCreateInput>;

export interface VehicleStatusTransitionInput {
  status: Exclude<VehicleStatus, 'PLANNED'>;
  reason: string;
  /** Status the decision was based on; the API refuses the change if it moved. */
  expectedStatus?: VehicleStatus;
}

export interface VehicleMediaInput {
  primaryMediaId: string | null;
  gallery: Array<{ mediaId: string; kind?: VehicleMediaKind | null }>;
}

export type TripStatus = 'DRAFT' | 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface AdminTripSummary {
  id: string;
  reference: string;
  routeVersionId: string;
  vehicleId: string | null;
  supportVehicleId: string | null;
  status: TripStatus;
  /** UTC instants (ISO 8601). */
  plannedDepartureAt: string | null;
  plannedArrivalAt: string | null;
  scheduledAt: string | null;
  cancelledAt: string | null;
  /** Database-owned operational clocks from PR-17 dispatch. */
  actualDepartureAt: string | null;
  actualArrivalAt: string | null;
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
    name: string | null;
    status: VehicleStatus;
    manufacturer: string;
    model: string;
    /** The vehicle's current configuration (may differ from the trip's later). */
    seatMapVersion: AssignedSeatMapVersion | null;
  } | null;
  supportVehicle: {
    id: string;
    code: string;
    name: string | null;
    status: VehicleStatus;
    manufacturer: string;
    model: string;
    role: VehicleRole;
    payloadCapacityKg: number | null;
    cargoVolumeLiters: number | null;
  } | null;
  /** Historical seat map of the trip; frozen once SCHEDULED. */
  seatMapVersionId: string | null;
  seatMapVersion: AssignedSeatMapVersion | null;
  /** Historical pricing of the trip; frozen once SCHEDULED. */
  fareTableVersionId: string | null;
  /** Full summary with pricing.read; its identity only otherwise. */
  fareTableVersion: AssignedFareTableVersion | TripFareTableIdentity | null;
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
  fromSupportVehicleCode: string | null;
  toSupportVehicleCode: string | null;
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

export type TripCostStatus = 'DRAFT' | 'ESTIMATED' | 'LOCKED';
export type TripCostCategory =
  | 'FUEL'
  | 'TOLLS'
  | 'FERRY'
  | 'BORDER_FEES'
  | 'PERMITS'
  | 'DRIVERS'
  | 'ACCOMMODATION'
  | 'MEALS_ALLOWANCES'
  | 'MAINTENANCE'
  | 'INSURANCE'
  | 'CLEANING_PREPARATION'
  | 'PARKING'
  | 'STOP_COST'
  | 'SUPPORT_VEHICLE'
  | 'CONTINGENCY'
  | 'OTHER';

export interface TripCostItem {
  id: string;
  category: TripCostCategory;
  label: string;
  /** Exact integer minor units, represented as a string for BIGINT safety. */
  amountMinor: string;
  notes: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface TripCostPlan {
  /** null until the first mutation; reads still expose the implied empty draft. */
  id: string | null;
  tripId: string;
  status: TripCostStatus;
  currencyCode: 'EUR';
  currencyMinorUnit: 2;
  totalCostMinor: string;
  createdAt: string | null;
  updatedAt: string | null;
  items: TripCostItem[];
}

export interface TripCostReplaceInput {
  status: TripCostStatus;
  currencyCode: 'EUR';
  items: Array<{
    category: TripCostCategory;
    label: string;
    amountMinor: string;
    notes?: string;
    position: number;
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

export interface TripSupportVehicleInput {
  supportVehicleId: string | null;
  expectedSupportVehicleId?: string | null;
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

/** A stop as shown to travellers (no coordinates, no internal flags). */
export interface BookingSearchStop {
  id: string;
  code: string;
  name: string;
  locality: string;
  /** IANA timezone, for presentation (times are UTC instants). */
  timezone: string;
  country: { iso2: string; name: string };
}

export interface BookingStopListOptions {
  query?: string;
  limit?: number;
  cursor?: string;
}

/** Exact base fare of one journey, per seat. */
export interface BookingFare {
  amountMinor: number;
  currencyCode: string;
  currencyMinorUnit: number;
}

export interface BookingJourneyOrigin {
  routeWaypointId: string;
  stop: BookingSearchStop | null;
  plannedDepartureAt: string | null;
}

export interface BookingJourneyDestination {
  routeWaypointId: string;
  stop: BookingSearchStop | null;
  plannedArrivalAt: string | null;
}

/** One bookable journey: a trip and an exact origin/destination waypoint pair. */
export interface BookingSearchResult {
  tripId: string;
  tripReference: string;
  route: { code: string; name: string };
  origin: BookingJourneyOrigin;
  destination: BookingJourneyDestination;
  fare: BookingFare;
  seatCount: number;
  availableSeatCount: number;
  /** Main MEDIA-1 image of the actually assigned active vehicle, when any. */
  vehiclePrimaryMedia: PublicMedia | null;
}

/** An active vehicle as shown on the website: no VIN, plate or status. */
export interface PublicVehicle {
  code: string;
  name: string | null;
  manufacturer: string;
  model: string;
  modelYear: number | null;
  amenities: VehicleAmenity[];
  /** SEAT cells of its current seat map; null without one. */
  seatCount: number | null;
  primaryMedia: PublicMedia | null;
  gallery: Array<PublicMedia & { kind: VehicleMediaKind | null; position: number }>;
}

/** One waypoint of a bookable trip, in route order (planned UTC instants). */
export interface BookingItineraryWaypoint {
  routeWaypointId: string;
  sequence: number;
  kind: 'STOP' | 'CHECKPOINT';
  /** Stop code; null for a checkpoint. */
  code: string | null;
  name: string;
  locality: string;
  timezone: string;
  country: { iso2: string; name: string };
  /** Structural checkpoint type; null for passenger stops. */
  checkpointType: string | null;
  /** Traveller-facing Teranga Stop purpose; null for passenger stops. */
  terangaStopKind: string | null;
  /** Services explicitly verified by OPS for a traveller-visible checkpoint. */
  facilities: string[];
  boardingAllowed: boolean;
  alightingAllowed: boolean;
  plannedArrivalAt: string | null;
  plannedDepartureAt: string | null;
}

/** Planned itinerary of a bookable trip; the vehicle only while it is active. */
export interface BookingItinerary {
  tripId: string;
  tripReference: string;
  route: { code: string; name: string };
  vehicle: Omit<PublicVehicle, 'seatCount'> | null;
  waypoints: BookingItineraryWaypoint[];
}

export interface BookingSearchOptions {
  originStopId: string;
  destinationStopId: string;
  /** ISO 8601 instants bounding the origin departure. */
  departureFrom?: string;
  departureTo?: string;
  minAvailableSeats?: number;
  limit?: number;
  cursor?: string;
}

/** A physical cell of the trip's historical seat map. */
export interface BookingAvailabilityCell {
  id: string;
  deck: number;
  row: number;
  column: number;
  kind: SeatMapCellKind;
  seatLabel: string | null;
  /** SEAT cells only: free on every segment of the requested journey. */
  available?: boolean;
}

export interface BookingAvailability {
  tripId: string;
  tripReference: string;
  seatMapVersionId: string;
  origin: BookingJourneyOrigin;
  destination: BookingJourneyDestination;
  fare: BookingFare;
  /** Seats per hold, decided by the server. */
  maxSeatsPerHold: number;
  seatCount: number;
  availableSeatCount: number;
  cells: BookingAvailabilityCell[];
}

/**
 * Derived, never stored: CANCELLED, else CONFIRMED (a payment succeeded; the
 * seats stay occupied after the hold expiry), else EXPIRED (database clock),
 * else HELD.
 */
export type CustomerBookingStatus = 'HELD' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';

/** One payment attempt: PENDING, then a single terminal state. */
export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** PAY-HUB-1: what the customer chooses (a provider is the server's business). */
export type PaymentMethodCode =
  | 'CARD'
  | 'CARD_CB'
  | 'CARD_VISA'
  | 'CARD_MASTERCARD'
  | 'CARD_AMEX'
  | 'APPLE_PAY'
  | 'GOOGLE_PAY'
  | 'PAYPAL'
  | 'SEPA_CREDIT_TRANSFER'
  | 'SEPA_DIRECT_DEBIT'
  | 'BIZUM'
  | 'WERO'
  | 'KLARNA'
  | 'ALMA'
  | 'WAVE_SN'
  | 'ORANGE_MONEY_SN'
  | 'FREE_MONEY_SN'
  | 'EXPRESSO_SN'
  | 'WIZALL_SN'
  | 'DJAMO_SN'
  | 'MAROCPAY'
  | 'CMI_CARD'
  | 'MOROCCO_CASH_AGENCY'
  | 'BANKILY_MR'
  | 'MASRVI_MR'
  | 'SEDAD_MR'
  | 'BIMBANK_MR'
  | 'CLICK_MR'
  | 'BCI_PAY_MR'
  | 'BANK_TRANSFER'
  | 'CASH_AT_AGENCY';

/** Payer countries of the corridor. */
export type PayerCountryCode = 'FR' | 'ES' | 'MA' | 'MR' | 'SN';

/** Providers of the programme; real adapters remain disabled until configured and released. */
export type PaymentProviderCode =
  | 'SANDBOX'
  | 'STRIPE'
  | 'PAYPAL'
  | 'PAYDUNYA'
  | 'PAYTECH'
  | 'WAVE'
  | 'ORANGE_MONEY'
  | 'CMI'
  | 'CHARIPAY'
  | 'MOOSYL'
  | 'MANUAL_BANK_TRANSFER'
  | 'CASH';

/** An exact amount in minor units, with its currency. */
export interface PaymentAmount {
  amountMinor: number;
  currencyCode: string;
  currencyMinorUnit: number;
}

/** A card network accepted by the provider that would collect a card (PAY-EU-1). */
export type CardNetworkCode = 'CB' | 'VISA' | 'MASTERCARD' | 'AMEX';

/** One method of a payer country, and whether it can be used right now. */
export interface PaymentOption {
  code: PaymentMethodCode;
  label: string;
  group: 'RECOMMENDED' | 'MOBILE_MONEY' | 'CARD_WALLET' | 'BANK' | 'AGENCY';
  available: boolean;
  /** CARD only, when available: the networks accepted (badges, never choices). */
  acceptedNetworks: CardNetworkCode[];
  /**
   * CARD only, when available: wallets the provider's page may also offer on
   * an eligible device. Device eligibility is unknown: never a promise.
   */
  deviceWallets: Array<'APPLE_PAY' | 'GOOGLE_PAY'>;
}

/** GET bookings/:reference/payment-options: nothing about providers or routing. */
export interface PaymentOptions {
  country: PayerCountryCode;
  currency: string;
  currencyMinorUnit: number;
  methods: PaymentOption[];
}

/** The customer's intentions; the server computes every amount and the rate. */
export interface PaymentQuoteInput {
  payerCountry: PayerCountryCode;
  paymentMethod: PaymentMethodCode;
}

/**
 * An immutable quote: the booking amount, the amount the payer will be asked
 * for in their currency, the exact rate and the validity. A new price is a
 * new quote; a quote takes no money and confirms nothing.
 */
export interface PaymentQuote {
  id: string;
  paymentMethod: PaymentMethodCode;
  payerCountry: PayerCountryCode;
  booking: PaymentAmount;
  presentment: PaymentAmount;
  /** Exact decimal string (booking major unit -> presentment major unit). */
  fxRate: string;
  fxSource:
    'FX_IDENTITY' | 'FX_SYNTHETIC_CI' | 'FX_MANUAL_OPS' | 'FX_PROVIDER' | 'FX_EXTERNAL_SERVICE';
  quotedAt: string;
  expiresAt: string;
}

/** Which quote to pay, and its method confirmed: never an amount. */
export interface CreatePaymentInput {
  quoteId: string;
  paymentMethod: PaymentMethodCode;
}

/**
 * A payment attempt of the signed-in customer. amountMinor is the booking
 * amount, derived by the server (exact integer, minor units); presentment is
 * what the payer was asked for (null for attempts made before PAY-HUB-1). No
 * provider id, failure detail, signature or card data is ever exposed.
 */
export interface CustomerPayment {
  reference: string;
  status: PaymentStatus;
  amountMinor: number;
  currencyCode: string;
  currencyMinorUnit: number;
  paymentMethod: PaymentMethodCode | null;
  payerCountry: PayerCountryCode | null;
  presentment: PaymentAmount | null;
  createdAt: string;
  succeededAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
}

/**
 * A started attempt. SANDBOX (development, tests, CI only) collects nothing in
 * the browser: no redirect, no card; the result arrives as a provider event.
 * A redirect, when a provider has one, never confirms anything by itself.
 */
export interface CreatePaymentResult {
  payment: CustomerPayment;
  checkout: { provider: PaymentProviderCode; testMode: boolean; redirectUrl: string | null };
}

/** Normalized failure codes (never raw provider text). */
export type PaymentFailureCode =
  | 'DECLINED'
  | 'INSUFFICIENT_FUNDS'
  | 'AUTHENTICATION_FAILED'
  | 'CHECKOUT_EXPIRED'
  | 'PROVIDER_ERROR'
  | 'UNKNOWN'
  | 'BOOKING_EXPIRED'
  | 'BOOKING_NOT_PAYABLE';

export interface CustomerBookingSeat {
  seatLabel: string | null;
  deck: number;
  row: number;
  column: number;
  releasedAt: string | null;
}

/**
 * A booking of the signed-in customer: a provisional hold until a payment
 * confirms it (CONFIRMED is paid, but not yet a ticket).
 */
export interface CustomerBooking {
  reference: string;
  status: CustomerBookingStatus;
  trip: { id: string; reference: string; route: { code: string; name: string } };
  origin: BookingJourneyOrigin;
  destination: BookingJourneyDestination;
  seats: CustomerBookingSeat[];
  unitAmountMinor: number;
  seatCount: number;
  /** unitAmountMinor x seatCount, computed exactly by the server. */
  totalAmountMinor: number;
  currencyCode: string;
  currencyMinorUnit: number;
  holdExpiresAt: string;
  cancelledAt: string | null;
  /** Set once, when a payment succeeded. */
  confirmedAt: string | null;
  /** Latest payment attempt (the succeeded one once CONFIRMED), or null. */
  payment: CustomerPayment | null;
  createdAt: string;
}

/** The only authority a customer has: trip, journey and seats. */
export interface CreateBookingInput {
  tripId: string;
  originRouteWaypointId: string;
  destinationRouteWaypointId: string;
  seatMapCellIds: string[];
}

export interface AdminBookingSeat extends CustomerBookingSeat {
  seatMapCellId: string;
}

/**
 * STAFF view (booking.read): no customer email, an opaque identity id. Its
 * payment attempts are present only for callers holding payment.read.
 */
export interface AdminBooking extends Omit<CustomerBooking, 'seats' | 'payment'> {
  id: string;
  customerIdentityId: string;
  tripStatus: TripStatus;
  seats: AdminBookingSeat[];
  cancellationReason: string | null;
  payments?: AdminPayment[];
}

/** STAFF view of a payment attempt (payment.read). */
export interface AdminPayment extends CustomerPayment {
  id: string;
  provider: PaymentProviderCode;
  /** The provider's opaque id, for reconciliation (not a secret). */
  providerPaymentId: string | null;
  booking: { id: string; reference: string; status: CustomerBookingStatus };
  customerIdentityId: string;
  /** The quote the attempt was started from (null before PAY-HUB-1). */
  quote: {
    id: string;
    fxRate: string;
    fxSource: PaymentQuote['fxSource'];
    quotedAt: string;
    expiresAt: string;
  } | null;
  failureCode: PaymentFailureCode | null;
}

/** A provider event as recorded: what happened and when, never its payload. */
export interface AdminPaymentEvent {
  id: string;
  type: 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED';
  providerEventId: string;
  receivedAt: string;
  /** Set when the event moved the attempt out of PENDING. */
  processedAt: string | null;
  /** Why a recorded event changed nothing. */
  rejectionCode: string | null;
}

export interface AdminPaymentDetail extends AdminPayment {
  events: AdminPaymentEvent[];
}

export type PaymentPage = Page<AdminPayment>;

export interface AdminPaymentListOptions {
  cursor?: string;
  limit?: number;
  status?: PaymentStatus;
  bookingReference?: string;
  paymentReference?: string;
  provider?: PaymentProviderCode;
  method?: PaymentMethodCode;
  payerCountry?: PayerCountryCode;
  /** Presentment currency. */
  currency?: 'EUR' | 'XOF' | 'MAD' | 'MRU';
  /** ISO 8601 with offset. */
  createdFrom?: string;
  createdTo?: string;
}

export type FinanceRevenueType = 'BAGGAGE' | 'OPTION' | 'OTHER';
export type FinanceExpenseType =
  'FUEL' | 'FERRY' | 'TOLL' | 'CREW' | 'HOTEL' | 'MAINTENANCE' | 'BORDER' | 'INSURANCE' | 'OTHER';
export type FinanceEntryStatus = 'ACTIVE' | 'VOIDED';

export interface FinanceCurrencySummary {
  currencyCode: string;
  currencyMinorUnit: number;
  ticketRevenueMinor: string;
  additionalRevenueMinor: string;
  grossRevenueMinor: string;
  refundMinor: string;
  netRevenueMinor: string;
  expenseMinor: string;
  contributionMinor: string;
  payoutMinor: string;
  outstandingExpenseMinor: string;
}

export interface FinanceRefund {
  id: string;
  reference: string;
  amountMinor: string;
  reason: string;
  recordedAt: string;
  creditNote: { reference: string; issuedAt: string } | null;
}

export interface FinancePayment {
  id: string;
  reference: string;
  amountMinor: string;
  currencyCode: string;
  currencyMinorUnit: number;
  booking: { reference: string; cancelledAt: string | null };
  refunds: FinanceRefund[];
}

export interface FinanceRevenue {
  id: string;
  reference: string;
  type: FinanceRevenueType;
  status: FinanceEntryStatus;
  amountMinor: string;
  currencyCode: string;
  currencyMinorUnit: number;
  description: string;
  occurredAt: string;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  baggage: { reference: string } | null;
}

export interface FinancePayout {
  id: string;
  reference: string;
  amountMinor: string;
  currencyCode: string;
  currencyMinorUnit: number;
  note: string | null;
  paidAt: string;
  recordedAt: string;
}

export interface FinanceReceipt {
  id: string;
  reference: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface FinanceExpense {
  id: string;
  reference: string;
  type: FinanceExpenseType;
  status: FinanceEntryStatus;
  amountMinor: string;
  currencyCode: string;
  currencyMinorUnit: number;
  description: string;
  vendorLabel: string | null;
  occurredAt: string;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  payouts: FinancePayout[];
  receipts: FinanceReceipt[];
}

export interface FinanceTripSummary {
  trip: { id: string; reference: string; status: TripStatus };
  currencies: FinanceCurrencySummary[];
  payments: FinancePayment[];
  revenues: FinanceRevenue[];
  expenses: FinanceExpense[];
  /** PR-22 deliberately performs no cross-currency conversion. */
  fxConversionApplied: false;
}

export interface FinanceRevenueInput {
  type: FinanceRevenueType;
  amountMinor: string;
  currencyCode: string;
  currencyMinorUnit: number;
  description: string;
  occurredAt: string;
  baggageReference?: string;
}

export interface FinanceExpenseInput {
  type: FinanceExpenseType;
  amountMinor: string;
  currencyCode: string;
  currencyMinorUnit: number;
  description: string;
  vendorLabel?: string;
  occurredAt: string;
}

export interface FinanceRefundInput {
  clientRefundId: string;
  amountMinor: string;
  reason: string;
}

export interface FinanceRefundResult {
  created: boolean;
  refund: {
    id?: string;
    reference: string;
    amountMinor: string;
    reason: string;
    creditNote: { reference: string; issuedAt?: string } | null;
  };
}

export interface FinancePayoutInput {
  clientPayoutId: string;
  amountMinor: string;
  paidAt: string;
  note?: string;
}

export interface FinancePayoutResult {
  created: boolean;
  payout: FinancePayout;
}

export type AdminBookingPage = Page<AdminBooking>;

export interface AdminBookingListOptions {
  cursor?: string;
  limit?: number;
  status?: CustomerBookingStatus;
  tripId?: string;
  reference?: string;
}

export type PassengerDocumentType =
  'PASSPORT' | 'NATIONAL_ID' | 'RESIDENCE_PERMIT' | 'VISA' | 'PARENTAL_AUTHORIZATION' | 'OTHER';

/** Technical file-security state; ACCEPTED is never regulatory validity. */
export type PassengerDocumentStatus = 'QUARANTINED' | 'ACCEPTED' | 'REJECTED';

export interface Passenger {
  reference: string;
  givenName: string;
  familyName: string;
  /** ISO calendar date. */
  dateOfBirth: string;
  nationality: { iso2: string; iso3: string; name: string };
  bookingReferences: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PassengerCountry {
  id: string;
  iso2: string;
  name: string;
}

export interface PassengerCreateInput {
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  nationalityCountryId: string;
}

export interface PassengerDocument {
  reference: string;
  passenger: { reference: string; givenName: string; familyName: string };
  bookingReferences: string[];
  type: PassengerDocumentType;
  mimeType: 'application/pdf' | 'image/jpeg' | 'image/png';
  sizeBytes: number;
  status: PassengerDocumentStatus;
  expiresAt: string | null;
  createdAt: string;
  acceptedAt: string | null;
  rejectedAt: string | null;
}

export interface PassengerDocumentUploadInput {
  type: PassengerDocumentType;
  file: File;
  expiresAt?: string;
}

export interface AdminPassengerDocumentListOptions {
  cursor?: string;
  limit?: number;
  type?: PassengerDocumentType;
  status?: PassengerDocumentStatus;
  createdFrom?: string;
  createdTo?: string;
  bookingReference?: string;
  passengerReference?: string;
}

export interface PrivateDownload {
  blob: Blob;
  filename: string;
  mimeType: string;
}

export type BaggageType = 'SUITCASE' | 'TRAVEL_BAG' | 'BOX' | 'OTHER';
export type BaggageLifecycleStatus =
  'REGISTERED' | 'CHECKED_IN' | 'LOADED' | 'IN_TRANSIT' | 'ARRIVED' | 'DELIVERED' | 'REMOVED';
export type BaggageExceptionStatus = 'MISSING' | 'DAMAGED' | 'HELD_BY_CUSTOMS';
export type BaggageOperationalEventType =
  Exclude<BaggageLifecycleStatus, 'REGISTERED'> | BaggageExceptionStatus | 'EXCEPTION_RESOLVED';
export type BaggageEventType = 'REGISTERED' | BaggageOperationalEventType | 'WEIGHT_UPDATED';

export interface BaggageLocation {
  sequence: number;
  kind: 'STOP' | 'CHECKPOINT';
  code: string;
  name: string;
  checkpointType: NetworkCheckpointType | null;
}

export interface BaggageEvent {
  sequence: number;
  type: BaggageEventType;
  lifecycleStatus: BaggageLifecycleStatus;
  exceptionStatus: BaggageExceptionStatus | null;
  /** Exact kilograms, always three decimals; null before STAFF measurement. */
  measuredWeightKg: string | null;
  occurredAt: string;
  recordedAt: string;
  location: BaggageLocation | null;
}

export interface Baggage {
  reference: string;
  /** PII-free opaque payload. It is an identifier, never authorization. */
  qrPayload: string;
  type: BaggageType;
  lifecycleStatus: BaggageLifecycleStatus;
  exceptionStatus: BaggageExceptionStatus | null;
  /** Exact kilograms, always three decimals; null before STAFF measurement. */
  measuredWeightKg: string | null;
  allowance: {
    includedWeightKg: string | null;
    excessWeightKg: string | null;
    excessCharge: { amountMinor: string; currencyCode: string } | null;
  };
  passenger: { reference: string; givenName: string; familyName: string };
  booking: {
    reference: string;
    trip: {
      reference: string;
      route: { code: string; name: string };
      plannedDepartureAt: string | null;
      plannedArrivalAt: string | null;
    };
  };
  createdAt: string;
  updatedAt: string;
}

export interface BaggageDetail extends Baggage {
  events: BaggageEvent[];
}

export interface BaggageQr {
  reference: string;
  /** Locally generated SVG; callers must render it as an image, not executable markup. */
  svg: string;
}

export interface BaggageEventResult {
  /** false means an identical clientEventId replay returned the original event. */
  created: boolean;
  event: BaggageEvent;
}

export interface BaggageEventInput {
  type: BaggageOperationalEventType;
  occurredAt?: string;
  routeWaypointId?: string | null;
  clientEventId?: string;
}

export interface BaggageWeightInput {
  /** Exact decimal string; CUSTOMER APIs never accept this input. */
  measuredWeightKg: string;
  occurredAt?: string;
  routeWaypointId?: string | null;
  clientEventId?: string;
}

export interface BaggageListOptions {
  cursor?: string;
  limit?: number;
  reference?: string;
  bookingReference?: string;
  passengerReference?: string;
  tripReference?: string;
  type?: BaggageType;
  lifecycleStatus?: BaggageLifecycleStatus;
  exceptionStatus?: BaggageExceptionStatus;
  createdFrom?: string;
  createdTo?: string;
}

export type RoadFreightDirection = 'PAR_DKR' | 'DKR_PAR';
export type RoadFreightLifecycleStatus =
  | 'QUOTE'
  | 'BOOKED'
  | 'RECEIVED'
  | 'INSPECTED'
  | 'ASSIGNED'
  | 'LOADED'
  | 'DEPARTED'
  | 'IN_TRANSIT'
  | 'ARRIVED'
  | 'AVAILABLE'
  | 'DELIVERED'
  | 'REFUSED'
  | 'CANCELLED';
export type RoadFreightExceptionStatus = 'HELD' | 'CUSTOMS_HOLD' | 'DAMAGED';
export type RoadFreightOperationalEventType =
  | Exclude<RoadFreightLifecycleStatus, 'QUOTE' | 'ASSIGNED'>
  | RoadFreightExceptionStatus
  | 'EXCEPTION_RESOLVED';
export type RoadFreightEventType =
  'QUOTE' | 'ASSIGNED' | 'ASSIGNMENT_UPDATED' | RoadFreightOperationalEventType;

export interface RoadFreightDeclaredValue {
  amountMinor: string;
  currencyCode: string;
  currencyMinorUnit: number;
}

export interface RoadFreightEvent {
  sequence: number;
  type: RoadFreightEventType;
  lifecycleStatus: RoadFreightLifecycleStatus;
  exceptionStatus: RoadFreightExceptionStatus | null;
  occurredAt: string;
  recordedAt: string;
  assignment: { tripId: string | null; vehicleId: string | null };
  location: {
    sequence: number;
    kind: 'STOP' | 'CHECKPOINT';
    code: string | null;
    name: string | null;
    checkpointType: string | null;
  } | null;
}

export interface RoadFreightShipment {
  reference: string;
  direction: RoadFreightDirection;
  lifecycleStatus: RoadFreightLifecycleStatus;
  exceptionStatus: RoadFreightExceptionStatus | null;
  senderName: string;
  recipientName: string;
  /** Exact kilograms, always three decimals. */
  weightKg: string;
  volumeLiters: number;
  packageCount: number;
  dimensionsCm: { length: number; width: number; height: number } | null;
  declaredContents: string;
  declaredValue: RoadFreightDeclaredValue | null;
  fragile: boolean;
  professional: boolean;
  pickupRequired: boolean;
  deliveryRequired: boolean;
  booking: { reference: string } | null;
  customer: { id: string; email: string } | null;
  trip: {
    id: string;
    reference: string;
    status: TripStatus;
    route: { code: string; name: string };
    plannedDepartureAt: string | null;
    plannedArrivalAt: string | null;
  } | null;
  vehicle: {
    id: string;
    code: string;
    name: string | null;
    role: VehicleRole;
    payloadCapacityKg: number | null;
    cargoVolumeLiters: number | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoadFreightShipmentDetail extends RoadFreightShipment {
  senderContact: string;
  recipientContact: string;
  events: RoadFreightEvent[];
}

export interface RoadFreightCreateInput {
  direction: RoadFreightDirection;
  bookingReference?: string;
  customerIdentityId?: string;
  senderName: string;
  senderContact: string;
  recipientName: string;
  recipientContact: string;
  weightKg: string;
  volumeLiters: number;
  packageCount: number;
  dimensionsCm?: { length: number; width: number; height: number } | null;
  declaredContents: string;
  declaredValue?: RoadFreightDeclaredValue | null;
  fragile: boolean;
  professional: boolean;
  pickupRequired: boolean;
  deliveryRequired: boolean;
}

export interface RoadFreightUpdateInput {
  senderName?: string;
  senderContact?: string;
  recipientName?: string;
  recipientContact?: string;
  weightKg?: string;
  volumeLiters?: number;
  packageCount?: number;
  dimensionsCm?: { length: number; width: number; height: number } | null;
  declaredContents?: string;
  declaredValue?: RoadFreightDeclaredValue | null;
  fragile?: boolean;
  professional?: boolean;
  pickupRequired?: boolean;
  deliveryRequired?: boolean;
  expectedUpdatedAt?: string;
}

export interface RoadFreightAssignmentInput {
  tripReference: string;
  vehicleCode: string;
  occurredAt?: string;
  expectedTripReference?: string | null;
  expectedVehicleCode?: string | null;
}

export interface RoadFreightEventInput {
  type: RoadFreightOperationalEventType;
  occurredAt?: string;
  routeWaypointId?: string | null;
  clientEventId?: string;
}

export interface RoadFreightEventResult {
  created: boolean;
  event: RoadFreightEvent;
}

export interface RoadFreightListOptions {
  cursor?: string;
  limit?: number;
  reference?: string;
  bookingReference?: string;
  tripReference?: string;
  vehicleCode?: string;
  direction?: RoadFreightDirection;
  lifecycleStatus?: RoadFreightLifecycleStatus;
  exceptionStatus?: RoadFreightExceptionStatus;
  createdFrom?: string;
  createdTo?: string;
}

/** PR-14: the six server-derived check-in gates of one BookingPassenger. */
export type CheckInGate = 'BOOKING' | 'PAYMENT' | 'DOCUMENTS' | 'COMPLIANCE' | 'SEAT' | 'BAGGAGE';
export type CheckInGateStatus = 'PASS' | 'BLOCKED' | 'PENDING_REVIEW';
export type CheckInBlockerCode =
  | 'BOOKING_NOT_CONFIRMED'
  | 'BOOKING_CANCELLED'
  | 'TRIP_NOT_SCHEDULED'
  | 'PAYMENT_NOT_SUCCEEDED'
  | 'DOCUMENTS_NOT_VERIFIED'
  | 'DOCUMENTS_NOT_ACCEPTED'
  | 'DOCUMENTS_INCOMPLETE'
  | 'DOCUMENTS_REVIEW_REQUIRED'
  | 'COMPLIANCE_MISSING'
  | 'COMPLIANCE_STALE'
  | 'COMPLIANCE_REVIEW_REQUIRED'
  | 'COMPLIANCE_NEEDS_INFORMATION'
  | 'COMPLIANCE_NON_COMPLIANT'
  | 'SEAT_NOT_ASSIGNED'
  | 'SEAT_RELEASED'
  | 'BAGGAGE_EXCEPTION_ACTIVE';

export interface CheckInBlocker {
  check: CheckInGate;
  code: CheckInBlockerCode;
  /** Business reference the blocker is about (a bag). */
  reference?: string;
}

export interface CheckInReadiness {
  engineVersion: string;
  eligible: boolean;
  checks: Array<{ check: CheckInGate; status: CheckInGateStatus; blockers: CheckInBlockerCode[] }>;
  blockers: CheckInBlocker[];
  /** PR-12 customer guidance of the requirements still to satisfy. */
  complianceGuidance: string[];
}

export interface CheckInTrip {
  reference: string;
  route: { code: string; name: string };
  plannedDepartureAt: string | null;
  plannedArrivalAt: string | null;
}

/** CUSTOMER view: the QR payload is PII-free and grants nothing by itself. */
export interface PassengerCheckIn {
  reference: string;
  checkedInAt: string;
  qrPayload: string;
  seat: { label: string };
  passenger: { reference: string; givenName: string; familyName: string };
  booking: { reference: string };
  trip: CheckInTrip;
  boarding: { reference: string; boardedAt: string } | null;
}

export interface PassengerBoarding {
  reference: string;
  boardedAt: string;
  occurredAt: string;
  /** Operational metadata only (no identity proof). */
  deviceId: string;
}

export interface StaffPassengerCheckIn extends Omit<PassengerCheckIn, 'boarding'> {
  channel: 'CUSTOMER' | 'STAFF';
  engineVersion: string;
  checksAtCheckIn: Array<{ check: CheckInGate; status: CheckInGateStatus }>;
  /** Present when the gates were re-derived for this response. */
  current?: boolean;
  factsChangedSinceCheckIn?: boolean;
  boarding: PassengerBoarding | null;
}

export interface CheckInResult<T> {
  /** false: the existing check-in of this BookingPassenger was returned. */
  created: boolean;
  checkIn: T;
}

export interface SeatAssignmentResult {
  changed: boolean;
  seat: { label: string };
}

export interface CheckInQr {
  reference: string;
  /** Locally generated SVG; render it as an image, never as markup. */
  svg: string;
}

export interface BookingCheckInOverview {
  booking: { reference: string };
  trip: CheckInTrip;
  seats: Array<{ label: string; assignedTo: string | null }>;
  items: Array<{
    passenger: { reference: string; givenName: string; familyName: string };
    seat: { label: string } | null;
    readiness: CheckInReadiness;
    checkIn: PassengerCheckIn | null;
  }>;
}

export interface StaffCheckInListItem {
  passenger: { reference: string; givenName: string; familyName: string };
  booking: { reference: string };
  trip: CheckInTrip;
  seat: { label: string } | null;
  readiness: { eligible: boolean; blockers: CheckInBlocker[] };
  checkIn: { reference: string; checkedInAt: string } | null;
  boarding: { reference: string; boardedAt: string } | null;
}

export interface StaffCheckInDetail {
  passenger: { reference: string; givenName: string; familyName: string } | null;
  booking: { reference: string };
  trip: CheckInTrip;
  seat: { label: string } | null;
  seats: Array<{ label: string; assigned: boolean }>;
  readiness: CheckInReadiness;
  checkIn: StaffPassengerCheckIn | null;
}

export interface CheckInListOptions {
  cursor?: string;
  limit?: number;
  tripReference?: string;
  bookingReference?: string;
  passengerReference?: string;
  checkInStatus?: 'CHECKED_IN' | 'NOT_CHECKED_IN';
  boardingStatus?: 'BOARDED' | 'NOT_BOARDED';
}

export interface BoardingResolution {
  checkIn: StaffPassengerCheckIn;
  readiness: CheckInReadiness;
}

export interface BoardingScanInput {
  /** Bounded operational device label; PR-18 owns device enrollment. */
  deviceId: string;
  /** Makes a retried scan idempotent (requires occurredAt). */
  clientEventId?: string;
  occurredAt?: string;
}

export interface BoardingResult {
  /** false: an identical clientEventId replay returned the original boarding. */
  created: boolean;
  boarding: PassengerBoarding;
}

export interface CrewTripSnapshot {
  assignmentId: string;
  snapshotExpiresAt: string;
  trip: {
    reference: string;
    status: 'SCHEDULED' | 'IN_PROGRESS';
    plannedDepartureAt: string | null;
    plannedArrivalAt: string | null;
    vehicleCode: string | null;
    route: { code: string; name: string };
    waypoints: Array<{
      id: string;
      sequence: number;
      kind: 'STOP' | 'CHECKPOINT';
      code: string;
      name: string;
      checkpointType: NetworkCheckpointType | null;
      borderState:
        'PENDING' | 'ARRIVED' | 'CONTROL_STARTED' | 'CONTROL_COMPLETED' | 'DEPARTED' | null;
    }>;
  };
}

export interface CrewTripList {
  serverTime: string;
  items: CrewTripSnapshot[];
}

export interface CrewDevice {
  deviceId: string;
  label: string | null;
  enrolledAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export type CrewOfflineEvent =
  | {
      clientEventId: string;
      type: 'PASSENGER_BOARDING';
      occurredAt: string;
      payload: { qrPayload: string };
    }
  | {
      clientEventId: string;
      type: 'TRACKING_CHECKPOINT';
      occurredAt: string;
      payload: { routeWaypointId: string };
    }
  | {
      clientEventId: string;
      type: 'BORDER_EVENT';
      occurredAt: string;
      payload: {
        routeWaypointId: string;
        eventType: 'ARRIVED' | 'CONTROL_STARTED' | 'CONTROL_COMPLETED' | 'DEPARTED';
      };
    }
  | {
      clientEventId: string;
      type: 'INCIDENT_REPORTED';
      occurredAt: string;
      payload: {
        incidentType:
          | 'BREAKDOWN'
          | 'ACCIDENT'
          | 'DELAY'
          | 'BORDER'
          | 'CUSTOMS'
          | 'POLICE'
          | 'PASSENGER'
          | 'HEALTH'
          | 'BAGGAGE'
          | 'SECURITY'
          | 'WEATHER'
          | 'FERRY'
          | 'OTHER';
        severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
        description: string;
        routeWaypointId?: string;
        locationLabel?: string;
        baggageReference?: string;
      };
    };

export interface CrewSyncResult {
  tripReference: string;
  results: Array<
    | {
        clientEventId: string;
        status: 'ACKNOWLEDGED';
        created: boolean;
        boardingReference?: string;
        trackingObservationId?: string;
        borderEventId?: string;
        incidentReference?: string;
      }
    | {
        clientEventId: string;
        status: 'RETRY';
        errorCode: string;
        retryAfterSeconds: number;
      }
    | {
        clientEventId: string;
        status: 'REJECTED' | 'CONFLICT';
        errorCode: string;
      }
  >;
}

export interface CrewTripAssignment {
  id: string;
  assignedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  crew: { id: string; email: string; status: string };
}

export type IncidentType =
  | 'BREAKDOWN'
  | 'ACCIDENT'
  | 'DELAY'
  | 'BORDER'
  | 'CUSTOMS'
  | 'POLICE'
  | 'PASSENGER'
  | 'HEALTH'
  | 'BAGGAGE'
  | 'SECURITY'
  | 'WEATHER'
  | 'FERRY'
  | 'OTHER';

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type IncidentStatus =
  'OPEN' | 'ASSESSING' | 'ACTION_REQUIRED' | 'MITIGATING' | 'RESOLVED' | 'CLOSED';
export type IncidentSource = 'STAFF' | 'CREW';
export type IncidentActionType =
  'NOTE' | 'ACTION_PLAN' | 'MITIGATION' | 'PASSENGERS_INFORMED' | 'POSTMORTEM';

export interface IncidentSummary {
  id: string;
  reference: string;
  type: IncidentType;
  severity: IncidentSeverity;
  status: IncidentStatus;
  source: IncidentSource;
  description: string;
  locationLabel: string | null;
  openedAt: string;
  recordedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  ownerIdentityId: string | null;
  trip: { id: string; reference: string; status: TripStatus };
  vehicle: { id: string; code: string } | null;
  waypoint: {
    id: string;
    sequence: number;
    code: string | null;
    name: string | null;
    checkpointType: string | null;
  } | null;
  baggage: {
    id: string;
    reference: string;
    exceptionStatus: string | null;
  } | null;
  actionCount: number;
  attachmentCount: number;
}

export interface IncidentAction {
  id: string;
  sequence: number;
  type: IncidentActionType;
  content: string;
  clientActionId: string;
  createdByIdentityId: string;
  createdAt: string;
}

export interface IncidentAttachment {
  id: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByIdentityId: string;
  createdAt: string;
}

export interface IncidentDetail extends IncidentSummary {
  actions: IncidentAction[];
  attachments: IncidentAttachment[];
}

export interface IncidentListOptions {
  cursor?: string;
  limit?: number;
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  type?: IncidentType;
  tripReference?: string;
  ownerIdentityId?: string;
}

export interface IncidentOpenInput {
  tripReference: string;
  clientEventId: string;
  type: IncidentType;
  severity: IncidentSeverity;
  description: string;
  openedAt: string;
  routeWaypointId?: string;
  locationLabel?: string;
  baggageReference?: string;
  ownerIdentityId?: string;
}

export interface IncidentOpenResult {
  created: boolean;
  incident: IncidentSummary;
}

export interface IncidentActionInput {
  clientActionId: string;
  type: IncidentActionType;
  content: string;
}

export interface IncidentActionResult {
  created: boolean;
  action: IncidentAction;
}

export interface IncidentOwner {
  id: string;
  email: string;
}

export type BorderEventType = 'ARRIVED' | 'CONTROL_STARTED' | 'CONTROL_COMPLETED' | 'DEPARTED';
export type BorderEventSource = 'STAFF' | 'CREW';
export type BorderState = 'PENDING' | BorderEventType;

export interface BorderTripView {
  trip: { id: string; reference: string; status: TripStatus };
  borders: Array<{
    routeWaypointId: string;
    sequence: number;
    code: string | null;
    name: string | null;
    currentState: BorderState;
    latestOccurredAt: string | null;
  }>;
  events: Array<{
    id: string;
    tripId: string;
    routeWaypointId: string;
    type: BorderEventType;
    source: BorderEventSource;
    clientEventId: string;
    occurredAt: string;
    recordedAt: string;
    waypoint: { sequence: number; code: string | null; name: string | null };
  }>;
}

export interface BorderEventInput {
  clientEventId: string;
  routeWaypointId: string;
  type: BorderEventType;
  occurredAt: string;
}

export interface BorderEventResult {
  created: boolean;
  event: BorderTripView['events'][number];
}

export type TrackingVisibility = 'HIDDEN' | 'CHECKPOINT_ONLY' | 'APPROXIMATE' | 'PRECISE';
export type TrackingProviderStatus = 'UP' | 'DEGRADED' | 'STALE' | 'UNAVAILABLE';
export type TrackingObservationSource = 'GPS' | 'CHECKPOINT' | 'CREW' | 'OPS' | 'SYSTEM';

export interface TrackingDevice {
  id: string;
  providerKey: string;
  externalId: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
  vehicle: { id: string; code: string; status?: string };
}

export interface TrackingConfig {
  enabled: boolean;
  visibility: TrackingVisibility;
  trackingDevice: Pick<TrackingDevice, 'id' | 'providerKey' | 'externalId' | 'active'> | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface TrackingCheckpointProjection {
  sequence: number;
  kind: 'STOP' | 'CHECKPOINT';
  code: string;
  name: string;
  type?: string;
  observedAt: string;
}

export interface TrackingObservation {
  id: string;
  source: TrackingObservationSource;
  observedAt: string;
  receivedAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  speedKph: number | null;
  headingDegrees: number | null;
  routeWaypointId: string | null;
  label: string | null;
  providerKey: string | null;
  providerObservationId: string | null;
  clientEventId: string | null;
  checkpoint: TrackingCheckpointProjection | null;
}

export interface TrackingPublicTokenSummary {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
}

export interface TrackingTripSummary {
  id: string;
  reference: string;
  status: TripStatus;
  plannedDepartureAt: string | null;
  plannedArrivalAt: string | null;
  vehicle: { id: string; code: string } | null;
  route: { code: string; name: string };
  config: TrackingConfig | null;
  lastObservation: { observedAt: string; source: TrackingObservationSource } | null;
  providerStatus: TrackingProviderStatus;
}

export interface TrackingTripDetail extends Omit<TrackingTripSummary, 'lastObservation'> {
  observations: TrackingObservation[];
  publicTokens: TrackingPublicTokenSummary[];
}

export interface TrackingConfigInput {
  enabled: boolean;
  visibility: TrackingVisibility;
  trackingDeviceId: string | null;
}

export interface TrackingConfigMutationResult {
  tripId: string;
  enabled: boolean;
  visibility: TrackingVisibility;
  trackingDeviceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrackingObservationInput {
  source: 'CHECKPOINT' | 'OPS';
  clientEventId?: string;
  observedAt: string;
  routeWaypointId?: string;
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  speedKph?: number;
  headingDegrees?: number;
  label?: string;
}

export interface TrackingObservationResult {
  created: boolean;
  observation: TrackingObservation;
}

export interface TrackingIssuedToken {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  token: string;
}

export interface PublicTrackingProjection {
  tripReference: string;
  tripStatus: TripStatus;
  route: { code: string; name: string };
  plannedDepartureAt: string | null;
  plannedArrivalAt: string | null;
  visibility: Exclude<TrackingVisibility, 'HIDDEN'>;
  providerStatus: TrackingProviderStatus;
  lastUpdatedAt: string | null;
  checkpoint: TrackingCheckpointProjection | null;
  position: {
    observedAt: string;
    latitude: number;
    longitude: number;
    precision: 'APPROXIMATE' | 'PRECISE';
    accuracyMeters?: number | null;
  } | null;
}

/** PR-15 immutable, PII-minimised snapshot of checked-in passengers. */
export interface PassengerManifestPassenger {
  bookingReference: string;
  passengerReference: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  nationality: { iso2: string; iso3: string };
  origin: { sequence: number; code: string; name: string; countryIso2: string };
  destination: { sequence: number; code: string; name: string; countryIso2: string };
  seat: { label: string };
  checkIn: { reference: string; checkedInAt: string };
  boarding: { reference: string; boardedAt: string } | null;
}

export interface PassengerManifestSnapshot {
  schemaVersion: 'passenger-manifest/1';
  trip: {
    reference: string;
    plannedDepartureAt: string;
    plannedArrivalAt: string;
    vehicle: { code: string | null; registrationPlate: string | null };
  };
  passengers: PassengerManifestPassenger[];
}

export interface PassengerManifestSummary {
  reference: string;
  tripReference: string;
  version: number;
  schemaVersion: string;
  contentHash: string;
  passengerCount: number;
  boardedCount: number;
  generatedAt: string;
}

export interface PassengerManifest extends PassengerManifestSummary {
  snapshot: PassengerManifestSnapshot;
}

export interface PassengerManifestListOptions {
  tripReference: string;
  cursor?: number;
  limit?: number;
}

export interface PassengerManifestPage {
  items: PassengerManifestSummary[];
  nextCursor: number | null;
}

/** CMS-1: public website content. Documents follow @euroteranga/content. */
export type ContentKind = 'PAGE' | 'SITE_SETTINGS' | 'NAVIGATION';
export type ContentRevisionStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
export type ContentDocument = Record<string, unknown>;

export interface ContentRevisionSummary {
  id: string;
  revision: number;
  status: ContentRevisionStatus;
  note: string | null;
  basedOnRevision: number | null;
  author: { id: string; email: string } | null;
  publishedAt: string | null;
  publishedBy: { id: string; email: string } | null;
  supersededAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentRevision extends ContentRevisionSummary {
  document: ContentDocument;
}

export interface ContentEntrySummary {
  id: string;
  kind: ContentKind;
  key: string;
  title: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  draft: ContentRevisionSummary | null;
  published: ContentRevisionSummary | null;
}

export interface ContentEntryDetail {
  id: string;
  kind: ContentKind;
  key: string;
  lastRevision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  draft: ContentRevision | null;
  published: ContentRevision | null;
  history: ContentRevisionSummary[];
}

export interface ContentListOptions {
  kind?: ContentKind;
  cursor?: string;
  limit?: number;
}

export type ContentCreateInput =
  | { kind: 'PAGE'; path: string; title: string; description: string }
  | { kind: 'SITE_SETTINGS' }
  | { kind: 'NAVIGATION' };

export interface ContentDraftInput {
  document: ContentDocument;
  note?: string;
  /** updatedAt of the draft the editor started from, or null when there was none. */
  expectedDraftUpdatedAt: string | null;
}

export interface PublicContentPage {
  path: string;
  revision: number;
  publishedAt: string;
  document: ContentDocument;
}

export interface PublicContentSite {
  settings: ContentDocument | null;
  navigation: ContentDocument | null;
  updatedAt: string | null;
}

export interface PublicContentSitemap {
  items: Array<{ path: string; updatedAt: string }>;
}

/**
 * MEDIA-1 public media library. An image is immutable: replacing it means
 * uploading a new one; archiving an unused image is terminal.
 */
export type MediaStatus = 'ACTIVE' | 'ARCHIVED';

export interface MediaRendition {
  width: number;
  height: number;
  /** API path of the WebP file, e.g. `/v1/media/files/<id>/960.webp`. */
  path: string;
}

/** What the website may know about an active image. */
export interface PublicMedia {
  id: string;
  altText: string;
  caption: string | null;
  credit: string | null;
  width: number;
  height: number;
  /** Point kept visible when the image is cropped, in percent. */
  focalX: number;
  focalY: number;
  renditions: MediaRendition[];
}

export interface MediaUsage {
  kind: ContentKind | 'VEHICLE';
  key: string;
  status: 'DRAFT' | 'PUBLISHED' | VehicleStatus;
  /** The content entry is archived (not served) but could be unarchived. */
  entryArchived: boolean;
}

export interface MediaStaffRef {
  id: string;
  email: string;
}

export interface MediaAsset extends Omit<PublicMedia, 'renditions'> {
  status: MediaStatus;
  sourceFormat: 'jpeg' | 'png' | 'webp';
  sourceBytes: number;
  renditions: Array<MediaRendition & { bytes: number }>;
  createdAt: string;
  updatedAt: string;
  createdBy: MediaStaffRef | null;
  updatedBy: MediaStaffRef | null;
  archivedAt: string | null;
  archivedBy: MediaStaffRef | null;
  archiveReason: string | null;
  /** Detail only: drafts and live pages that show the image. */
  usages?: MediaUsage[];
}

export interface MediaListOptions {
  status?: MediaStatus;
  cursor?: string;
  limit?: number;
}

export interface MediaUploadInput {
  file: Blob;
  altText: string;
  caption?: string;
  credit?: string;
  focalX?: number;
  focalY?: number;
  /** The image this upload replaces (kept as is, recorded in the audit trail). */
  replaces?: string;
}

export interface MediaUpdateInput {
  altText?: string;
  caption?: string | null;
  credit?: string | null;
  focalX?: number;
  focalY?: number;
}

/** PR-16 generic operational permits. PERMIT_VALID is never TRIP_READY. */
export type RegulatoryPermitLifecycleStatus = 'DRAFT' | 'ACTIVE' | 'REVOKED';
export type RegulatoryPermitValidityState =
  'DRAFT' | 'NOT_YET_VALID' | 'VALID' | 'EXPIRED' | 'REVOKED';
export type RegulatoryPermitScopeType =
  'OPERATOR' | 'COUNTRY' | 'VEHICLE' | 'ROUTE_VERSION' | 'TRIP';

export type RegulatoryPermitScopeInput =
  | { type: 'OPERATOR' }
  | { type: 'COUNTRY'; countryIso2: string }
  | { type: 'VEHICLE'; vehicleCode: string }
  | { type: 'ROUTE_VERSION'; routeCode: string; routeVersion: number }
  | { type: 'TRIP'; tripReference: string };

export type RegulatoryPermitScope =
  | { type: 'OPERATOR'; label: 'EURO TERANGA' }
  | { type: 'COUNTRY'; country: { iso2: string; iso3: string; name: string } }
  | { type: 'VEHICLE'; vehicle: { code: string; registrationPlate: string | null } }
  | {
      type: 'ROUTE_VERSION';
      route: { code: string; name: string };
      routeVersion: number;
    }
  | { type: 'TRIP'; trip: { reference: string } };

export interface RegulatoryPermitInput {
  permitType: string;
  title: string;
  issuingAuthority: string;
  authorityReference?: string | null;
  jurisdictionCountryIso2?: string | null;
  scope: RegulatoryPermitScopeInput;
  validFrom: string;
  validUntil: string;
  sourceUrl?: string | null;
  sourceCheckedOn?: string | null;
  notes?: string | null;
}

export interface RegulatoryPermitUpdateInput {
  expectedRevision: number;
  permitType?: string;
  title?: string;
  issuingAuthority?: string;
  authorityReference?: string | null;
  jurisdictionCountryIso2?: string | null;
  scope?: RegulatoryPermitScopeInput;
  validFrom?: string;
  validUntil?: string;
  sourceUrl?: string | null;
  sourceCheckedOn?: string | null;
  notes?: string | null;
}

export interface RegulatoryPermitSummary {
  reference: string;
  permitType: string;
  title: string;
  issuingAuthority: string;
  authorityReference: string | null;
  jurisdictionCountry: { iso2: string; iso3: string; name: string } | null;
  scope: RegulatoryPermitScope;
  validFrom: string;
  validUntil: string;
  status: RegulatoryPermitLifecycleStatus;
  validityState: RegulatoryPermitValidityState;
  evaluatedOn: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  revokedAt: string | null;
}

export interface RegulatoryPermitHistoryEntry {
  action: string;
  occurredAt: string;
  status: RegulatoryPermitLifecycleStatus | null;
  revision: number | null;
  reason: string | null;
}

export interface RegulatoryPermitDetail extends RegulatoryPermitSummary {
  sourceUrl: string | null;
  sourceCheckedOn: string | null;
  notes: string | null;
  revocationReason: string | null;
  history: RegulatoryPermitHistoryEntry[];
}

export interface RegulatoryPermitListOptions {
  cursor?: string;
  limit?: number;
  status?: RegulatoryPermitLifecycleStatus;
  validityState?: RegulatoryPermitValidityState;
  scopeType?: RegulatoryPermitScopeType;
  permitType?: string;
  country?: string;
  vehicleCode?: string;
  routeCode?: string;
  routeVersion?: number;
  tripReference?: string;
  reference?: string;
}

/** PR-17 whole-trip departure readiness and dispatch. */
export type DepartureGate = 'TRIP' | 'VEHICLE' | 'PASSENGERS' | 'MANIFEST' | 'PERMITS';
export type DepartureBlockerCode =
  | 'TRIP_NOT_SCHEDULED'
  | 'VEHICLE_NOT_ASSIGNED'
  | 'VEHICLE_NOT_ACTIVE'
  | 'VEHICLE_SEAT_MAP_MISMATCH'
  | 'SUPPORT_VEHICLE_NOT_ACTIVE'
  | 'SUPPORT_VEHICLE_ROLE_INVALID'
  | 'SUPPORT_VEHICLE_CAPACITY_MISSING'
  | 'PASSENGER_NOT_CHECKED_IN'
  | 'PASSENGER_NOT_BOARDED'
  | 'PASSENGER_READINESS_STALE'
  | 'MANIFEST_MISSING'
  | 'MANIFEST_STALE'
  | 'PERMIT_POLICY_MISSING'
  | 'PERMIT_POLICY_STALE'
  | 'PERMIT_REQUIREMENT_UNSATISFIED';

export interface DepartureBlocker {
  gate: DepartureGate;
  code: DepartureBlockerCode;
  reference?: string;
  sequence?: number;
}

export interface DeparturePermitRequirementInput {
  permitType: string;
  scopeType: RegulatoryPermitScopeType;
  countryIso2?: string;
}

export interface DeparturePermitRequirement extends DeparturePermitRequirementInput {
  sequence: number;
  satisfied?: boolean;
  permitReference?: string;
}

export interface DeparturePermitPolicy {
  tripReference: string;
  version: number;
  schemaVersion: 'departure-permit-policy/1';
  contentHash: string;
  requirementCount: number;
  publishedAt: string;
  requirements: Array<Omit<DeparturePermitRequirement, 'satisfied' | 'permitReference'>>;
}

export interface DepartureReadinessSnapshot {
  engineVersion: 'departure-readiness/2';
  status: 'READY' | 'BLOCKED';
  trip: { reference: string; status: TripStatus };
  vehicle: { code: string; active: boolean; seatMapCompatible: boolean } | null;
  supportVehicle: {
    code: string;
    active: boolean;
    role: VehicleRole;
    payloadCapacityKg: number | null;
    cargoVolumeLiters: number | null;
  } | null;
  passengers: {
    total: number;
    checkedIn: number;
    boarded: number;
    currentReady: number;
    factsFingerprint: string;
  };
  manifest: {
    reference: string;
    version: number;
    contentHash: string;
    currentContentHash: string | null;
    passengerCount: number;
    boardedCount: number;
  } | null;
  permitPolicy: {
    version: number;
    contentHash: string;
    currentContentHash: string;
    requirementCount: number;
    requirements: DeparturePermitRequirement[];
  } | null;
  gates: Array<{
    gate: DepartureGate;
    status: 'PASS' | 'BLOCKED';
    blockers: DepartureBlockerCode[];
  }>;
  blockers: DepartureBlocker[];
}

export interface DepartureAuthorization {
  reference: string;
  version: number;
  engineVersion: 'departure-readiness/2';
  readinessFingerprint: string;
  authorizedAt: string;
}

export interface DepartureReadinessResponse {
  trip: {
    reference: string;
    status: TripStatus;
    actualDepartureAt: string | null;
    actualArrivalAt: string | null;
  };
  readiness: DepartureReadinessSnapshot;
  fingerprint: string;
  latestAuthorization: (DepartureAuthorization & { current: boolean }) | null;
}

export interface DepartureAuthorizationResult {
  created: boolean;
  authorization: DepartureAuthorization;
}

export interface DepartureDispatchResult {
  trip: {
    reference: string;
    status: TripStatus;
    actualDepartureAt: string | null;
    actualArrivalAt: string | null;
  };
  authorizationReference: string | null;
}

/**
 * PR-12 compliance. TECHNICALLY_ACCEPTED != REGULATORY_VALID and
 * NO_MATCHING_RULE != COMPLIANT: a stale evaluation is never current.
 */
export type ComplianceStatus =
  | 'NOT_EVALUATED'
  | 'STALE'
  | 'REVIEW_REQUIRED'
  | 'COMPLIANT_BY_RULES'
  | 'NON_COMPLIANT_BY_RULES'
  | 'COMPLIANT'
  | 'NON_COMPLIANT'
  | 'NEEDS_INFORMATION';
export type ComplianceResult = 'PASS' | 'FAIL' | 'REVIEW_REQUIRED';
export type ComplianceOutcome = ComplianceResult | 'NOT_APPLICABLE';
export type ComplianceReviewDecision = 'COMPLIANT' | 'NON_COMPLIANT' | 'NEEDS_INFORMATION';

export interface ComplianceFinding {
  code: string;
  documentType?: PassengerDocumentType | null;
  country?: string;
}

export interface CustomerPassengerCompliance {
  passenger: { reference: string; givenName: string; familyName: string };
  status: ComplianceStatus;
  evaluation: {
    reference: string;
    evaluatedAt: string;
    travelDate: string;
    result: ComplianceResult;
    current: boolean;
  } | null;
  review: {
    decision: ComplianceReviewDecision;
    reviewedAt: string;
    customerMessage: string | null;
  } | null;
  requirements: Array<{
    outcome: 'FAIL' | 'REVIEW_REQUIRED';
    guidance: string;
    findings: Array<{ code: string; documentType: PassengerDocumentType | null }>;
  }>;
  findings: ComplianceFinding[];
  documents: Array<{
    reference: string;
    type: PassengerDocumentType;
    technicalStatus: PassengerDocumentStatus;
  }>;
}

export interface CustomerBookingCompliance {
  bookingReference: string;
  items: CustomerPassengerCompliance[];
}

export type ComplianceRuleVersionStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

export interface ComplianceRuleSourceInput {
  authority: string | null;
  title: string | null;
  url: string | null;
  reference: string | null;
}

export interface ComplianceRuleVersionInput {
  /** Rule language v1 JSON; validated by the server, never executed. */
  definition: unknown;
  customerGuidance: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: ComplianceRuleSourceInput;
}

export interface ComplianceRuleVersion {
  version: number;
  status: ComplianceRuleVersionStatus;
  languageVersion: number;
  definition: unknown;
  definitionSha256: string;
  customerGuidance: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: ComplianceRuleSourceInput & { checkedOn: string | null };
  verification: {
    status: 'UNVERIFIED' | 'VERIFIED';
    verifiedAt: string | null;
    verifiedBy: string | null;
    note: string | null;
  };
  publishedAt: string | null;
  publishedBy: string | null;
  retiredAt: string | null;
  retiredBy: string | null;
  retirementReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceRule {
  reference: string;
  title: string;
  createdAt: string;
  versions: ComplianceRuleVersion[];
}

export interface ComplianceRuleSummary {
  reference: string;
  title: string;
  createdAt: string;
  versions: Array<{
    version: number;
    status: ComplianceRuleVersionStatus;
    verificationStatus: 'UNVERIFIED' | 'VERIFIED';
    effectiveFrom: string;
    effectiveTo: string | null;
  }>;
}

export interface ComplianceQueueItem {
  bookingReference: string;
  tripReference: string;
  departureAt: string;
  passenger: { reference: string; givenName: string; familyName: string };
  status: ComplianceStatus;
  evaluation: {
    reference: string;
    result: ComplianceResult;
    evaluatedAt: string;
    current: boolean;
  } | null;
  review: { decision: ComplianceReviewDecision; reviewedAt: string; current: boolean } | null;
}

export interface ComplianceQueueOptions {
  cursor?: string;
  limit?: number;
  status?: ComplianceStatus;
  tripReference?: string;
  bookingReference?: string;
  passengerReference?: string;
  departureFrom?: string;
  departureTo?: string;
}

export interface ComplianceEvaluationDetail {
  reference: string;
  bookingReference: string;
  tripReference: string;
  passenger: {
    reference: string;
    givenName: string;
    familyName: string;
    nationality: { iso2: string; name: string };
  };
  travelDate: string;
  arrivalDate: string;
  evaluatedAt: string;
  triggeredBy: 'CUSTOMER' | 'STAFF' | 'CREW';
  engineVersion: string;
  facts: unknown;
  factsFingerprint: string;
  rulesFingerprint: string;
  result: ComplianceResult;
  findings: ComplianceFinding[];
  latestEvaluationReference: string | null;
  current: boolean;
  status: ComplianceStatus;
  results: Array<{
    rule: { reference: string; title: string };
    version: {
      version: number;
      status: ComplianceRuleVersionStatus;
      effectiveFrom: string;
      effectiveTo: string | null;
      customerGuidance: string;
      source: ComplianceRuleSourceInput & { checkedOn: string | null };
    };
    outcome: ComplianceOutcome;
    reasonCode: string;
    details: ComplianceFinding[];
    evidence: Array<{
      reference: string;
      type: PassengerDocumentType;
      technicalStatus: PassengerDocumentStatus;
      expiresAt: string | null;
    }>;
  }>;
  reviews: Array<{
    id: string;
    decision: ComplianceReviewDecision;
    reason: string;
    customerMessage: string | null;
    reviewer: string;
    reviewedAt: string;
    supersedesReviewId: string | null;
    current: boolean;
  }>;
}

export interface ComplianceReviewInput {
  decision: ComplianceReviewDecision;
  /** Mandatory internal justification (10-1000 characters). */
  reason: string;
  customerMessage?: string;
  /** The latest review the reviewer saw, or null if there was none. */
  previousReviewId: string | null;
}

/** PR-23 aggregated operational reporting. No passenger PII and no FX conversion. */
export interface ReportingOverviewOptions {
  from: string;
  to: string;
  routeId?: string;
  tripId?: string;
  vehicleId?: string;
  status?: TripStatus;
}

export interface ReportingMoneySummary {
  currencyCode: string;
  currencyMinorUnit: number;
  ticketRevenueMinor: string;
  additionalRevenueMinor: string;
  grossRevenueMinor: string;
  refundMinor: string;
  refundRate: number | null;
  netRevenueMinor: string;
  expenseMinor: string;
  contributionMinor: string;
  contributionRate: number | null;
  payoutMinor: string;
  outstandingExpenseMinor: string;
  averageTicketRevenuePerConfirmedBookingMinor: string | null;
  averageNetRevenuePerPassengerMinor: string | null;
  averageNetRevenuePerSoldSeatMinor: string | null;
  profitableTripCount: number;
  lossTripCount: number;
  breakEvenTripCount: number;
}

export interface ReportingRouteSummary {
  routeVersionId: string;
  routeId: string;
  routeCode: string;
  routeName: string;
  routeVersion: number;
  tripCount: number;
  passengerCount: number;
  soldSeatCount: number;
  offeredSeatCapacity: number;
  loadFactor: number | null;
  cancellationCount: number;
  incidentCount: number;
  currencies: ReportingMoneySummary[];
}

export interface ReportingTripSummary {
  id: string;
  reference: string;
  status: TripStatus;
  plannedDepartureAt: string | null;
  plannedArrivalAt: string | null;
  route: { id: string; code: string; name: string; version: number };
  vehicle: { id: string; code: string } | null;
  bookingCount: number;
  cancelledBookingCount: number;
  passengerCount: number;
  soldSeatCount: number;
  offeredSeatCapacity: number;
  loadFactor: number | null;
  incidentCount: number;
  currencies: ReportingMoneySummary[];
}

export interface ReportingOverview {
  period: { from: string; to: string; semantics: '[from,to) on trip.plannedDepartureAt' };
  filters: {
    routeId: string | null;
    tripId: string | null;
    vehicleId: string | null;
    status: TripStatus | null;
  };
  activity: {
    tripCount: number;
    draftTripCount: number;
    scheduledTripCount: number;
    inProgressTripCount: number;
    completedTripCount: number;
    cancelledTripCount: number;
  };
  commercial: {
    bookingCount: number;
    confirmedBookingCount: number;
    cancelledBookingCount: number;
    passengerCount: number;
    soldSeatCount: number;
    offeredSeatCapacity: number;
    loadFactor: number | null;
    cancellationRate: number | null;
  };
  finance: { currencies: ReportingMoneySummary[]; fxConversionApplied: false };
  operations: {
    departureSampleCount: number;
    onTimeDepartureCount: number;
    delayedDepartureCount: number;
    averageDelayMinutes: number | null;
    maximumDelayMinutes: number | null;
    actualDurationSampleCount: number;
    averageActualDurationMinutes: number | null;
  };
  incidents: {
    incidentCount: number;
    openIncidentCount: number;
    resolvedIncidentCount: number;
    severity: { LOW: number; MEDIUM: number; HIGH: number; CRITICAL: number };
    averageResolutionMinutes: number | null;
  };
  baggage: {
    baggageCount: number;
    loadedBaggageCount: number;
    deliveredBaggageCount: number;
    anomalyBaggageCount: number;
    baggageIncidentCount: number;
    anomalyRate: number | null;
  };
  fleet: {
    vehicleCount: number;
    activeVehicleCount: number;
    outOfServiceVehicleCount: number;
    retiredVehicleCount: number;
    usedVehicleCount: number;
    activeUsedVehicleCount: number;
    utilizationRate: number | null;
    tripsPerUsedVehicle: number | null;
  };
  routes: ReportingRouteSummary[];
  recentTrips: ReportingTripSummary[];
  privacy: { containsPassengerPii: false };
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

/** Keeps only the known, server-built detail shape of an error body. */
function errorDetails(value: unknown): { details?: ApiErrorDetails } {
  if (typeof value !== 'object' || value === null) return {};
  const blockers = (value as { blockers?: unknown }).blockers;
  if (Array.isArray(blockers)) return { details: { blockers: blockers as CheckInBlocker[] } };
  const issues = (value as { issues?: unknown }).issues;
  if (Array.isArray(issues)) {
    const valid = issues
      .filter(
        (issue): issue is ContentIssue =>
          typeof issue === 'object' &&
          issue !== null &&
          typeof (issue as ContentIssue).path === 'string' &&
          typeof (issue as ContentIssue).message === 'string',
      )
      .slice(0, 50)
      .map(({ path, message }) => ({ path, message }));
    return { details: { issues: valid } };
  }
  const mediaId = (value as { mediaId?: unknown }).mediaId;
  if (typeof mediaId === 'string' && /^[0-9a-f-]{36}$/.test(mediaId)) {
    return { details: { mediaId } };
  }
  const usages = (value as { usages?: unknown }).usages;
  if (Array.isArray(usages)) {
    const valid = usages
      .filter(
        (usage): usage is MediaUsage =>
          typeof usage === 'object' &&
          usage !== null &&
          typeof (usage as MediaUsage).kind === 'string' &&
          typeof (usage as MediaUsage).key === 'string' &&
          ['DRAFT', 'PUBLISHED', 'PLANNED', 'ACTIVE', 'OUT_OF_SERVICE', 'RETIRED'].includes(
            (usage as MediaUsage).status,
          ),
      )
      .slice(0, 50)
      .map(({ kind, key, status, entryArchived }) => ({
        kind,
        key,
        status,
        entryArchived: entryArchived === true,
      }));
    return { details: { usages: valid } };
  }
  return {};
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
    options: { body?: unknown; csrf?: string; headers?: Record<string, string> } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { ...options.headers };
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
        ...errorDetails(body.details),
      },
    };
  }

  function errorResult(response: Response, payload: unknown): ApiResult<never> {
    const body = (payload ?? {}) as Partial<ApiError>;
    return {
      ok: false,
      error: {
        status: response.status,
        code: typeof body.code === 'string' ? body.code : 'UNKNOWN_ERROR',
        message: typeof body.message === 'string' ? body.message : UNEXPECTED_ERROR,
        ...errorDetails(body.details),
      },
    };
  }

  async function withCsrfMultipart<T>(
    realm: Realm,
    path: string,
    form: FormData,
  ): Promise<ApiResult<T>> {
    const csrf = await call<{ csrfToken: string }>('GET', `/v1/auth/${realm}/csrf`);
    if (!csrf.ok) return csrf;
    let response: Response;
    try {
      response = await fetch(`${root}${path}`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf.data.csrfToken },
        credentials: 'include',
        cache: 'no-store',
        // The browser sets the boundary. Setting Content-Type here would make
        // the multipart body invalid.
        body: form,
      });
    } catch {
      return { ok: false, error: NETWORK_ERROR };
    }
    const payload: unknown = await response.json().catch(() => undefined);
    return response.ok ? { ok: true, data: payload as T } : errorResult(response, payload);
  }

  async function privateDownload(path: string): Promise<ApiResult<PrivateDownload>> {
    let response: Response;
    try {
      response = await fetch(`${root}${path}`, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      });
    } catch {
      return { ok: false, error: NETWORK_ERROR };
    }
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      return errorResult(response, payload);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const filename = /filename="([A-Za-z0-9._-]+)"/u.exec(disposition)?.[1] ?? 'document';
    const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';
    return { ok: true, data: { blob: await response.blob(), filename, mimeType } };
  }

  async function withCsrf<T>(
    realm: Realm,
    path: string,
    body: unknown = {},
    headers?: Record<string, string>,
  ): Promise<ApiResult<T>> {
    const csrf = await call<{ csrfToken: string }>('GET', `/v1/auth/${realm}/csrf`);
    if (!csrf.ok) return csrf;
    return call<T>('POST', path, {
      body,
      csrf: csrf.data.csrfToken,
      ...(headers ? { headers } : {}),
    });
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
    /**
     * Booking (PR-09). Public reads need no session; customer actions use the
     * CUSTOMER session and a CSRF token on mutations. A hold is provisional:
     * not paid, not a ticket.
     */
    booking: {
      public: {
        stops: (options: BookingStopListOptions = {}) =>
          call<Page<BookingSearchStop>>(
            'GET',
            `/v1/booking/stops?${query({ query: options.query, limit: options.limit, cursor: options.cursor })}`,
          ),
        searchTrips: (options: BookingSearchOptions) =>
          call<Page<BookingSearchResult>>(
            'GET',
            `/v1/booking/trips?${query({
              originStopId: options.originStopId,
              destinationStopId: options.destinationStopId,
              departureFrom: options.departureFrom,
              departureTo: options.departureTo,
              minAvailableSeats: options.minAvailableSeats,
              limit: options.limit,
              cursor: options.cursor,
            })}`,
          ),
        availability: (
          tripId: string,
          originRouteWaypointId: string,
          destinationRouteWaypointId: string,
        ) =>
          call<BookingAvailability>(
            'GET',
            `/v1/booking/trips/${encodeURIComponent(tripId)}/availability?${query({
              originRouteWaypointId,
              destinationRouteWaypointId,
            })}`,
          ),
        itinerary: (tripId: string) =>
          call<BookingItinerary>(
            'GET',
            `/v1/booking/trips/${encodeURIComponent(tripId)}/itinerary`,
          ),
        /** Active vehicles ("Nos bus"): public facts only. */
        fleet: () => call<{ items: PublicVehicle[] }>('GET', '/v1/booking/fleet'),
      },
      customer: {
        passengerCountries: () =>
          call<{ items: PassengerCountry[] }>('GET', '/v1/booking/passenger-countries'),
        createHold: (input: CreateBookingInput) =>
          withCsrf<CustomerBooking>('customer', '/v1/booking/bookings', input),
        bookings: (options: { cursor?: string; limit?: number } = {}) =>
          call<Page<CustomerBooking>>(
            'GET',
            `/v1/booking/bookings?${query({ cursor: options.cursor, limit: options.limit })}`,
          ),
        booking: (reference: string) =>
          call<CustomerBooking>('GET', `/v1/booking/bookings/${encodeURIComponent(reference)}`),
        cancel: (reference: string) =>
          withCsrf<CustomerBooking>(
            'customer',
            `/v1/booking/bookings/${encodeURIComponent(reference)}/cancel`,
          ),
        /** PAY-HUB-1: the methods of a payer country for this booking. */
        paymentOptions: (reference: string, payerCountry: PayerCountryCode) =>
          call<PaymentOptions>(
            'GET',
            `/v1/booking/bookings/${encodeURIComponent(reference)}/payment-options?${query({ payerCountry })}`,
          ),
        /** PAY-HUB-1: an immutable quote of the amount to pay; takes no money. */
        createPaymentQuote: (reference: string, input: PaymentQuoteInput) =>
          withCsrf<PaymentQuote>(
            'customer',
            `/v1/booking/bookings/${encodeURIComponent(reference)}/payment-quotes`,
            input,
          ),
        /**
         * Starts a payment attempt for a HELD booking from one of its quotes.
         * Reuse the same idempotency key (and the same quote) when retrying
         * the same intent: the API then returns the same attempt instead of
         * creating another one.
         */
        createPayment: (reference: string, input: CreatePaymentInput, idempotencyKey?: string) =>
          withCsrf<CreatePaymentResult>(
            'customer',
            `/v1/booking/bookings/${encodeURIComponent(reference)}/payments`,
            input,
            idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
          ),
        listPayments: (reference: string) =>
          call<{ items: CustomerPayment[] }>(
            'GET',
            `/v1/booking/bookings/${encodeURIComponent(reference)}/payments`,
          ),
        /** Gives up a PENDING attempt; the booking stays HELD. */
        cancelPayment: (paymentReference: string) =>
          withCsrf<CustomerPayment>(
            'customer',
            `/v1/booking/payments/${encodeURIComponent(paymentReference)}/cancel`,
          ),
        createPassenger: (bookingReference: string, input: PassengerCreateInput) =>
          withCsrf<Passenger>(
            'customer',
            `/v1/booking/bookings/${encodeURIComponent(bookingReference)}/passengers`,
            input,
          ),
        passengers: (bookingReference: string) =>
          call<{ items: Passenger[] }>(
            'GET',
            `/v1/booking/bookings/${encodeURIComponent(bookingReference)}/passengers`,
          ),
        passenger: (passengerReference: string) =>
          call<Passenger>(
            'GET',
            `/v1/booking/passengers/${encodeURIComponent(passengerReference)}`,
          ),
        documents: (passengerReference: string) =>
          call<{ items: PassengerDocument[] }>(
            'GET',
            `/v1/booking/passengers/${encodeURIComponent(passengerReference)}/documents`,
          ),
        uploadDocument: (passengerReference: string, input: PassengerDocumentUploadInput) => {
          const form = new FormData();
          form.append('type', input.type);
          if (input.expiresAt) form.append('expiresAt', input.expiresAt);
          form.append('file', input.file, input.file.name);
          return withCsrfMultipart<PassengerDocument>(
            'customer',
            `/v1/booking/passengers/${encodeURIComponent(passengerReference)}/documents`,
            form,
          );
        },
        downloadDocument: (documentReference: string) =>
          privateDownload(
            `/v1/booking/documents/${encodeURIComponent(documentReference)}/download`,
          ),
        /** PR-13: the server derives BookingPassenger, trip and CUSTOMER ownership. */
        registerBaggage: (
          bookingReference: string,
          passengerReference: string,
          input: { type: BaggageType },
        ) =>
          withCsrf<BaggageDetail>(
            'customer',
            `/v1/booking/bookings/${encodeURIComponent(bookingReference)}/passengers/${encodeURIComponent(passengerReference)}/baggage`,
            input,
          ),
        baggageForBooking: (bookingReference: string) =>
          call<{ items: Baggage[] }>(
            'GET',
            `/v1/booking/bookings/${encodeURIComponent(bookingReference)}/baggage`,
          ),
        baggage: (reference: string) =>
          call<BaggageDetail>('GET', `/v1/booking/baggage/${encodeURIComponent(reference)}`),
        baggageQr: (reference: string) =>
          call<BaggageQr>('GET', `/v1/booking/baggage/${encodeURIComponent(reference)}/qr`),
        /** PR-14: seats, six gates and check-ins of an owned booking (no side effect). */
        checkInOverview: (bookingReference: string) =>
          call<BookingCheckInOverview>(
            'GET',
            `/v1/booking/bookings/${encodeURIComponent(bookingReference)}/check-in`,
          ),
        checkInReadiness: (bookingReference: string, passengerReference: string) =>
          call<CheckInReadiness>(
            'GET',
            `/v1/booking/bookings/${encodeURIComponent(bookingReference)}/passengers/${encodeURIComponent(passengerReference)}/check-in-readiness`,
          ),
        /** Links the traveller to a seat already booked; never a new seat. */
        assignSeat: (bookingReference: string, passengerReference: string, seatLabel: string) =>
          withCsrf<SeatAssignmentResult>(
            'customer',
            `/v1/booking/bookings/${encodeURIComponent(bookingReference)}/passengers/${encodeURIComponent(passengerReference)}/seat`,
            { seatLabel },
          ),
        /** No input: the server derives every gate; a 409 lists the blockers. */
        checkIn: (bookingReference: string, passengerReference: string) =>
          withCsrf<CheckInResult<PassengerCheckIn>>(
            'customer',
            `/v1/booking/bookings/${encodeURIComponent(bookingReference)}/passengers/${encodeURIComponent(passengerReference)}/check-in`,
          ),
        checkInQr: (checkInReference: string) =>
          call<CheckInQr>(
            'GET',
            `/v1/booking/check-ins/${encodeURIComponent(checkInReference)}/qr`,
          ),
        /** PR-12: compliance of the caller's own booking passengers (no side effect). */
        compliance: (bookingReference: string) =>
          call<CustomerBookingCompliance>(
            'GET',
            `/v1/booking/bookings/${encodeURIComponent(bookingReference)}/compliance`,
          ),
        /** PR-12: evaluates from server-side facts; deduplicated when nothing changed. */
        evaluateCompliance: (bookingReference: string, passengerReference: string) =>
          withCsrf<CustomerPassengerCompliance>(
            'customer',
            `/v1/booking/bookings/${encodeURIComponent(bookingReference)}/passengers/${encodeURIComponent(passengerReference)}/compliance-evaluations`,
          ),
      },
    },
    tracking: {
      public: (token: string) =>
        call<PublicTrackingProjection>('GET', '/v1/tracking/' + encodeURIComponent(token)),
    },
    content: {
      page: (path: string) =>
        call<PublicContentPage>('GET', `/v1/content/pages?${query({ path })}`),
      site: () => call<PublicContentSite>('GET', '/v1/content/site'),
      sitemap: () => call<PublicContentSitemap>('GET', '/v1/content/sitemap'),
    },
    /** MEDIA-1: active images only; unknown or archived ids are absent. */
    media: {
      many: (ids: readonly string[]) =>
        call<{ items: PublicMedia[] }>('GET', `/v1/media?${query({ ids: ids.join(',') })}`),
      /** Absolute URL of a rendition path returned by the API. */
      url: (path: string) => `${root}${path}`,
    },
    crew: {
      trips: () => call<CrewTripList>('GET', '/v1/crew/trips'),
      trip: (tripReference: string) =>
        call<CrewTripSnapshot & { serverTime: string }>(
          'GET',
          `/v1/crew/trips/${encodeURIComponent(tripReference)}`,
        ),
      device: (deviceId: string) =>
        call<CrewDevice>('GET', `/v1/crew/devices/${encodeURIComponent(deviceId)}`),
      enrollDevice: (deviceId: string, label?: string) =>
        withCsrf<CrewDevice>('crew', '/v1/crew/devices/enroll', {
          deviceId,
          ...(label ? { label } : {}),
        }),
      revokeDevice: (deviceId: string, reason: string) =>
        withCsrf<CrewDevice>('crew', `/v1/crew/devices/${encodeURIComponent(deviceId)}/revoke`, {
          reason,
        }),
      sync: (tripReference: string, deviceId: string, events: CrewOfflineEvent[]) =>
        withCsrf<CrewSyncResult>(
          'crew',
          `/v1/crew/trips/${encodeURIComponent(tripReference)}/events/sync`,
          { deviceId, events },
        ),
      reportTrackingCheckpoint: (
        tripReference: string,
        input: {
          deviceId: string;
          clientEventId: string;
          routeWaypointId: string;
          occurredAt: string;
        },
      ) =>
        withCsrf<TrackingObservationResult>(
          'crew',
          '/v1/crew/trips/' + encodeURIComponent(tripReference) + '/tracking/checkpoints',
          input,
        ),
    },
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
            `/v1/admin/fleet/vehicles?${query({
              cursor: options.cursor,
              limit: options.limit,
              status: options.status,
              role: options.role,
            })}`,
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
        assignVehicleMedia: (vehicleId: string, input: VehicleMediaInput) =>
          withCsrf<AdminVehicleDetail>(
            'staff',
            `/v1/admin/fleet/vehicles/${encodeURIComponent(vehicleId)}/media`,
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
        tripCosts: (tripId: string) =>
          call<TripCostPlan>('GET', `/v1/admin/trips/${encodeURIComponent(tripId)}/costs`),
        replaceTripCosts: (tripId: string, input: TripCostReplaceInput) =>
          withCsrf<TripCostPlan>(
            'staff',
            `/v1/admin/trips/${encodeURIComponent(tripId)}/costs`,
            input,
          ),
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
        assignTripSupportVehicle: (tripId: string, input: TripSupportVehicleInput) =>
          withCsrf<AdminTrip>(
            'staff',
            `/v1/admin/trips/${encodeURIComponent(tripId)}/support-vehicle`,
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
        crewAssignments: (tripId: string) =>
          call<{ items: CrewTripAssignment[] }>(
            'GET',
            `/v1/admin/trips/${encodeURIComponent(tripId)}/crew-assignments`,
          ),
        assignCrew: (tripId: string, crewIdentityId: string, expiresAt?: string) =>
          withCsrf<{ created: boolean; assignment: CrewTripAssignment }>(
            'staff',
            `/v1/admin/trips/${encodeURIComponent(tripId)}/crew-assignments`,
            { crewIdentityId, ...(expiresAt ? { expiresAt } : {}) },
          ),
        revokeCrewAssignment: (tripId: string, assignmentId: string, reason: string) =>
          withCsrf<CrewTripAssignment>(
            'staff',
            `/v1/admin/trips/${encodeURIComponent(tripId)}/crew-assignments/${encodeURIComponent(assignmentId)}/revoke`,
            { reason },
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
      bookings: {
        bookings: (options: AdminBookingListOptions = {}) =>
          call<AdminBookingPage>(
            'GET',
            `/v1/admin/bookings?${query({
              cursor: options.cursor,
              limit: options.limit,
              status: options.status,
              tripId: options.tripId,
              reference: options.reference,
            })}`,
          ),
        booking: (bookingId: string) =>
          call<AdminBooking>('GET', `/v1/admin/bookings/${encodeURIComponent(bookingId)}`),
        cancel: (bookingId: string, reason: string) =>
          withCsrf<AdminBooking>(
            'staff',
            `/v1/admin/bookings/${encodeURIComponent(bookingId)}/cancel`,
            { reason },
          ),
      },
      /** payment.read; payment.manage only gives up PENDING attempts (no "mark paid"). */
      payments: {
        listPayments: (options: AdminPaymentListOptions = {}) =>
          call<PaymentPage>(
            'GET',
            `/v1/admin/payments?${query({
              cursor: options.cursor,
              limit: options.limit,
              status: options.status,
              bookingReference: options.bookingReference,
              paymentReference: options.paymentReference,
              provider: options.provider,
              method: options.method,
              payerCountry: options.payerCountry,
              currency: options.currency,
              createdFrom: options.createdFrom,
              createdTo: options.createdTo,
            })}`,
          ),
        getPayment: (paymentId: string) =>
          call<AdminPaymentDetail>('GET', `/v1/admin/payments/${encodeURIComponent(paymentId)}`),
        cancelPayment: (paymentId: string, reason: string) =>
          withCsrf<AdminPaymentDetail>(
            'staff',
            `/v1/admin/payments/${encodeURIComponent(paymentId)}/cancel`,
            { reason },
          ),
      },
      /** PR-23: aggregate reporting; server calculations remain authoritative. */
      reporting: {
        overview: (options: ReportingOverviewOptions) =>
          call<ReportingOverview>(
            'GET',
            `/v1/admin/reporting/overview?${query({
              from: options.from,
              to: options.to,
              routeId: options.routeId,
              tripId: options.tripId,
              vehicleId: options.vehicleId,
              status: options.status,
            })}`,
          ),
        exportCsv: (options: ReportingOverviewOptions) =>
          privateDownload(
            `/v1/admin/reporting/export.csv?${query({
              from: options.from,
              to: options.to,
              routeId: options.routeId,
              tripId: options.tripId,
              vehicleId: options.vehicleId,
              status: options.status,
            })}`,
          ),
        exportXlsx: (options: ReportingOverviewOptions) =>
          privateDownload(
            `/v1/admin/reporting/export.xlsx?${query({
              from: options.from,
              to: options.to,
              routeId: options.routeId,
              tripId: options.tripId,
              vehicleId: options.vehicleId,
              status: options.status,
            })}`,
          ),
      },
      /** PR-22 operational finance. No FX conversion and no general ledger. */
      finance: {
        trip: (tripReference: string) =>
          call<FinanceTripSummary>(
            'GET',
            '/v1/admin/finance/trips/' + encodeURIComponent(tripReference),
          ),
        createRevenue: (tripReference: string, input: FinanceRevenueInput) =>
          withCsrf<FinanceRevenue>(
            'staff',
            '/v1/admin/finance/trips/' + encodeURIComponent(tripReference) + '/revenues',
            input,
          ),
        createExpense: (tripReference: string, input: FinanceExpenseInput) =>
          withCsrf<FinanceExpense>(
            'staff',
            '/v1/admin/finance/trips/' + encodeURIComponent(tripReference) + '/expenses',
            input,
          ),
        voidRevenue: (reference: string, reason: string) =>
          withCsrf<FinanceRevenue>(
            'staff',
            '/v1/admin/finance/revenues/' + encodeURIComponent(reference) + '/void',
            { reason },
          ),
        voidExpense: (reference: string, reason: string) =>
          withCsrf<FinanceExpense>(
            'staff',
            '/v1/admin/finance/expenses/' + encodeURIComponent(reference) + '/void',
            { reason },
          ),
        refundPayment: (paymentReference: string, input: FinanceRefundInput) =>
          withCsrf<FinanceRefundResult>(
            'staff',
            '/v1/admin/finance/payments/' + encodeURIComponent(paymentReference) + '/refunds',
            input,
          ),
        recordPayout: (expenseReference: string, input: FinancePayoutInput) =>
          withCsrf<FinancePayoutResult>(
            'staff',
            '/v1/admin/finance/expenses/' + encodeURIComponent(expenseReference) + '/payouts',
            input,
          ),
        uploadReceipt: (expenseReference: string, file: File) => {
          const form = new FormData();
          form.append('file', file, file.name);
          return withCsrfMultipart<FinanceReceipt>(
            'staff',
            '/v1/admin/finance/expenses/' + encodeURIComponent(expenseReference) + '/receipts',
            form,
          );
        },
        downloadReceipt: (expenseReference: string, receiptId: string) =>
          privateDownload(
            '/v1/admin/finance/expenses/' +
              encodeURIComponent(expenseReference) +
              '/receipts/' +
              encodeURIComponent(receiptId) +
              '/download',
          ),
        exportCsv: (tripReference: string) =>
          privateDownload(
            '/v1/admin/finance/trips/' + encodeURIComponent(tripReference) + '/export.csv',
          ),
        exportXlsx: (tripReference: string) =>
          privateDownload(
            '/v1/admin/finance/trips/' + encodeURIComponent(tripReference) + '/export.xlsx',
          ),
      },
      /** passenger.document.read; technical status only, no compliance action. */
      passengerDocuments: {
        list: (options: AdminPassengerDocumentListOptions = {}) =>
          call<Page<PassengerDocument>>(
            'GET',
            `/v1/admin/passenger-documents?${query({
              cursor: options.cursor,
              limit: options.limit,
              type: options.type,
              status: options.status,
              createdFrom: options.createdFrom,
              createdTo: options.createdTo,
              bookingReference: options.bookingReference,
              passengerReference: options.passengerReference,
            })}`,
          ),
        detail: (reference: string) =>
          call<PassengerDocument>(
            'GET',
            `/v1/admin/passenger-documents/${encodeURIComponent(reference)}`,
          ),
        download: (reference: string) =>
          privateDownload(
            `/v1/admin/passenger-documents/${encodeURIComponent(reference)}/download`,
          ),
      },
      /** baggage.read for reads; every mutation additionally requires baggage.manage. */
      baggage: {
        list: (options: BaggageListOptions = {}) =>
          call<Page<Baggage>>(
            'GET',
            `/v1/admin/baggage?${query({
              cursor: options.cursor,
              limit: options.limit,
              reference: options.reference,
              bookingReference: options.bookingReference,
              passengerReference: options.passengerReference,
              tripReference: options.tripReference,
              type: options.type,
              lifecycleStatus: options.lifecycleStatus,
              exceptionStatus: options.exceptionStatus,
              createdFrom: options.createdFrom,
              createdTo: options.createdTo,
            })}`,
          ),
        detail: (reference: string) =>
          call<BaggageDetail>('GET', `/v1/admin/baggage/${encodeURIComponent(reference)}`),
        qr: (reference: string) =>
          call<BaggageQr>('GET', `/v1/admin/baggage/${encodeURIComponent(reference)}/qr`),
        register: (input: {
          bookingReference: string;
          passengerReference: string;
          type: BaggageType;
        }) => withCsrf<BaggageDetail>('staff', '/v1/admin/baggage', input),
        updateWeight: (reference: string, input: BaggageWeightInput) =>
          withCsrf<BaggageEventResult>(
            'staff',
            `/v1/admin/baggage/${encodeURIComponent(reference)}/weight`,
            input,
          ),
        recordEvent: (reference: string, input: BaggageEventInput) =>
          withCsrf<BaggageEventResult>(
            'staff',
            `/v1/admin/baggage/${encodeURIComponent(reference)}/events`,
            input,
          ),
        scan: (qrPayload: string, input: BaggageEventInput) =>
          withCsrf<BaggageEventResult>('staff', '/v1/admin/baggage/scan', {
            qrPayload,
            ...input,
          }),
        resolveQr: (qrPayload: string) =>
          withCsrf<BaggageDetail>('staff', '/v1/admin/baggage/resolve-qr', { qrPayload }),
      },
      /** cargo.read for reads; every mutation additionally requires cargo.manage. */
      cargo: {
        list: (options: RoadFreightListOptions = {}) =>
          call<Page<RoadFreightShipment>>(
            'GET',
            `/v1/admin/cargo?${query({
              cursor: options.cursor,
              limit: options.limit,
              reference: options.reference,
              bookingReference: options.bookingReference,
              tripReference: options.tripReference,
              vehicleCode: options.vehicleCode,
              direction: options.direction,
              lifecycleStatus: options.lifecycleStatus,
              exceptionStatus: options.exceptionStatus,
              createdFrom: options.createdFrom,
              createdTo: options.createdTo,
            })}`,
          ),
        detail: (reference: string) =>
          call<RoadFreightShipmentDetail>(
            'GET',
            `/v1/admin/cargo/${encodeURIComponent(reference)}`,
          ),
        create: (input: RoadFreightCreateInput) =>
          withCsrf<RoadFreightShipmentDetail>('staff', '/v1/admin/cargo', input),
        update: (reference: string, input: RoadFreightUpdateInput) =>
          withCsrf<RoadFreightShipmentDetail>(
            'staff',
            `/v1/admin/cargo/${encodeURIComponent(reference)}/details`,
            input,
          ),
        assign: (reference: string, input: RoadFreightAssignmentInput) =>
          withCsrf<RoadFreightShipmentDetail>(
            'staff',
            `/v1/admin/cargo/${encodeURIComponent(reference)}/assignment`,
            input,
          ),
        recordEvent: (reference: string, input: RoadFreightEventInput) =>
          withCsrf<RoadFreightEventResult>(
            'staff',
            `/v1/admin/cargo/${encodeURIComponent(reference)}/events`,
            input,
          ),
      },
      /** PR-14: checkin.read for reads; seat and check-in need checkin.manage. */
      checkIn: {
        list: (options: CheckInListOptions = {}) =>
          call<Page<StaffCheckInListItem>>(
            'GET',
            `/v1/admin/check-in/booking-passengers?${query({
              cursor: options.cursor,
              limit: options.limit,
              tripReference: options.tripReference,
              bookingReference: options.bookingReference,
              passengerReference: options.passengerReference,
              checkInStatus: options.checkInStatus,
              boardingStatus: options.boardingStatus,
            })}`,
          ),
        detail: (bookingReference: string, passengerReference: string) =>
          call<StaffCheckInDetail>(
            'GET',
            `/v1/admin/check-in/bookings/${encodeURIComponent(bookingReference)}/passengers/${encodeURIComponent(passengerReference)}`,
          ),
        assignSeat: (bookingReference: string, passengerReference: string, seatLabel: string) =>
          withCsrf<SeatAssignmentResult>(
            'staff',
            `/v1/admin/check-in/bookings/${encodeURIComponent(bookingReference)}/passengers/${encodeURIComponent(passengerReference)}/seat`,
            { seatLabel },
          ),
        checkIn: (bookingReference: string, passengerReference: string) =>
          withCsrf<CheckInResult<StaffPassengerCheckIn>>(
            'staff',
            `/v1/admin/check-in/bookings/${encodeURIComponent(bookingReference)}/passengers/${encodeURIComponent(passengerReference)}/check-in`,
          ),
        qr: (checkInReference: string) =>
          call<CheckInQr>(
            'GET',
            `/v1/admin/check-in/check-ins/${encodeURIComponent(checkInReference)}/qr`,
          ),
      },
      /** PR-14: boarding.read resolves a QR; boarding needs boarding.scan. */
      boarding: {
        resolve: (qrPayload: string) =>
          withCsrf<BoardingResolution>('staff', '/v1/admin/boarding/resolve', { qrPayload }),
        scan: (qrPayload: string, input: BoardingScanInput) =>
          withCsrf<BoardingResult>('staff', '/v1/admin/boarding/scan', { qrPayload, ...input }),
      },
      /** PR-15: immutable history; each explicit generation creates a new version. */
      manifests: {
        list: (options: PassengerManifestListOptions) =>
          call<PassengerManifestPage>(
            'GET',
            `/v1/admin/manifests?${query({
              tripReference: options.tripReference,
              cursor: options.cursor,
              limit: options.limit,
            })}`,
          ),
        detail: (reference: string) =>
          call<PassengerManifest>('GET', `/v1/admin/manifests/${encodeURIComponent(reference)}`),
        generate: (tripReference: string) =>
          withCsrf<PassengerManifest>(
            'staff',
            `/v1/admin/manifests/trips/${encodeURIComponent(tripReference)}`,
          ),
        exportCsv: (reference: string) =>
          privateDownload(`/v1/admin/manifests/${encodeURIComponent(reference)}/export.csv`),
      },
      /** PR-17: whole-trip readiness and dispatch; the server is the authority. */
      departure: {
        readiness: (tripReference: string) =>
          call<DepartureReadinessResponse>(
            'GET',
            `/v1/admin/departure/trips/${encodeURIComponent(tripReference)}/readiness`,
          ),
        publishPermitPolicy: (
          tripReference: string,
          input: { requirements: DeparturePermitRequirementInput[] },
        ) =>
          withCsrf<DeparturePermitPolicy>(
            'staff',
            `/v1/admin/departure/trips/${encodeURIComponent(tripReference)}/permit-policy`,
            input,
          ),
        authorize: (tripReference: string) =>
          withCsrf<DepartureAuthorizationResult>(
            'staff',
            `/v1/admin/departure/trips/${encodeURIComponent(tripReference)}/authorize`,
          ),
        depart: (tripReference: string) =>
          withCsrf<DepartureDispatchResult>(
            'staff',
            `/v1/admin/departure/trips/${encodeURIComponent(tripReference)}/depart`,
          ),
        complete: (tripReference: string) =>
          withCsrf<DepartureDispatchResult>(
            'staff',
            `/v1/admin/departure/trips/${encodeURIComponent(tripReference)}/complete`,
          ),
      },
      /** PR-16: intrinsic permit validity only; PR-17 owns trip readiness. */
      content: {
        list: (options: ContentListOptions = {}) =>
          call<{ items: ContentEntrySummary[]; nextCursor: string | null }>(
            'GET',
            `/v1/admin/content/entries?${query({
              kind: options.kind,
              cursor: options.cursor,
              limit: options.limit,
            })}`,
          ),
        entry: (id: string) =>
          call<ContentEntryDetail>('GET', `/v1/admin/content/entries/${encodeURIComponent(id)}`),
        revision: (id: string, revision: number) =>
          call<ContentRevision>(
            'GET',
            `/v1/admin/content/entries/${encodeURIComponent(id)}/revisions/${revision}`,
          ),
        create: (input: ContentCreateInput) =>
          withCsrf<ContentEntryDetail>('staff', '/v1/admin/content/entries', input),
        saveDraft: (id: string, input: ContentDraftInput) =>
          withCsrf<ContentEntryDetail>(
            'staff',
            `/v1/admin/content/entries/${encodeURIComponent(id)}/draft`,
            input,
          ),
        publish: (id: string, expectedDraftUpdatedAt: string) =>
          withCsrf<ContentEntryDetail>(
            'staff',
            `/v1/admin/content/entries/${encodeURIComponent(id)}/publish`,
            { expectedDraftUpdatedAt },
          ),
        discardDraft: (id: string, expectedDraftUpdatedAt: string) =>
          withCsrf<ContentEntryDetail>(
            'staff',
            `/v1/admin/content/entries/${encodeURIComponent(id)}/discard-draft`,
            { expectedDraftUpdatedAt },
          ),
        restore: (id: string, revision: number, note?: string) =>
          withCsrf<ContentEntryDetail>(
            'staff',
            `/v1/admin/content/entries/${encodeURIComponent(id)}/restore`,
            { revision, ...(note ? { note } : {}) },
          ),
        archive: (id: string, reason: string) =>
          withCsrf<ContentEntryDetail>(
            'staff',
            `/v1/admin/content/entries/${encodeURIComponent(id)}/archive`,
            { reason },
          ),
        unarchive: (id: string) =>
          withCsrf<ContentEntryDetail>(
            'staff',
            `/v1/admin/content/entries/${encodeURIComponent(id)}/unarchive`,
          ),
      },
      /** MEDIA-1: media.read to browse, media.manage to upload, describe, archive. */
      media: {
        list: (options: MediaListOptions = {}) =>
          call<{ storageEnabled: boolean; items: MediaAsset[]; nextCursor: string | null }>(
            'GET',
            `/v1/admin/media?${query({
              status: options.status,
              cursor: options.cursor,
              limit: options.limit,
            })}`,
          ),
        detail: (id: string) =>
          call<MediaAsset>('GET', `/v1/admin/media/${encodeURIComponent(id)}`),
        upload: (input: MediaUploadInput) => {
          const form = new FormData();
          form.append('altText', input.altText);
          if (input.caption) form.append('caption', input.caption);
          if (input.credit) form.append('credit', input.credit);
          if (input.focalX !== undefined) form.append('focalX', String(input.focalX));
          if (input.focalY !== undefined) form.append('focalY', String(input.focalY));
          if (input.replaces) form.append('replaces', input.replaces);
          // The file comes last: the describing fields are read first.
          form.append('file', input.file);
          return withCsrfMultipart<MediaAsset>('staff', '/v1/admin/media', form);
        },
        update: (id: string, input: MediaUpdateInput) =>
          withCsrf<MediaAsset>('staff', `/v1/admin/media/${encodeURIComponent(id)}`, input),
        archive: (id: string, reason: string) =>
          withCsrf<MediaAsset>('staff', `/v1/admin/media/${encodeURIComponent(id)}/archive`, {
            reason,
          }),
      },
      regulatoryPermits: {
        list: (options: RegulatoryPermitListOptions = {}) =>
          call<Page<RegulatoryPermitSummary>>(
            'GET',
            `/v1/admin/regulatory-permits?${query({
              cursor: options.cursor,
              limit: options.limit,
              status: options.status,
              validityState: options.validityState,
              scopeType: options.scopeType,
              permitType: options.permitType,
              country: options.country,
              vehicleCode: options.vehicleCode,
              routeCode: options.routeCode,
              routeVersion: options.routeVersion,
              tripReference: options.tripReference,
              reference: options.reference,
            })}`,
          ),
        detail: (reference: string) =>
          call<RegulatoryPermitDetail>(
            'GET',
            `/v1/admin/regulatory-permits/${encodeURIComponent(reference)}`,
          ),
        create: (input: RegulatoryPermitInput) =>
          withCsrf<RegulatoryPermitDetail>('staff', '/v1/admin/regulatory-permits', input),
        update: (reference: string, input: RegulatoryPermitUpdateInput) =>
          withCsrf<RegulatoryPermitDetail>(
            'staff',
            `/v1/admin/regulatory-permits/${encodeURIComponent(reference)}`,
            input,
          ),
        activate: (reference: string, expectedRevision: number) =>
          withCsrf<RegulatoryPermitDetail>(
            'staff',
            `/v1/admin/regulatory-permits/${encodeURIComponent(reference)}/activate`,
            { expectedRevision },
          ),
        revoke: (reference: string, input: { expectedRevision: number; reason: string }) =>
          withCsrf<RegulatoryPermitDetail>(
            'staff',
            `/v1/admin/regulatory-permits/${encodeURIComponent(reference)}/revoke`,
            input,
          ),
      },
      incidents: {
        list: (options: IncidentListOptions = {}) =>
          call<Page<IncidentSummary>>(
            'GET',
            '/v1/admin/incidents?' +
              query({
                cursor: options.cursor,
                limit: options.limit,
                status: options.status,
                severity: options.severity,
                type: options.type,
                tripReference: options.tripReference,
                ownerIdentityId: options.ownerIdentityId,
              }),
          ),
        owners: () => call<{ items: IncidentOwner[] }>('GET', '/v1/admin/incidents/owners'),
        detail: (reference: string) =>
          call<IncidentDetail>('GET', '/v1/admin/incidents/' + encodeURIComponent(reference)),
        open: (input: IncidentOpenInput) =>
          withCsrf<IncidentOpenResult>('staff', '/v1/admin/incidents', input),
        addAction: (reference: string, input: IncidentActionInput) =>
          withCsrf<IncidentActionResult>(
            'staff',
            '/v1/admin/incidents/' + encodeURIComponent(reference) + '/actions',
            input,
          ),
        transition: (
          reference: string,
          input: { status: IncidentStatus; expectedStatus?: IncidentStatus },
        ) =>
          withCsrf<IncidentSummary>(
            'staff',
            '/v1/admin/incidents/' + encodeURIComponent(reference) + '/transition',
            input,
          ),
        assignOwner: (
          reference: string,
          input: { ownerIdentityId: string | null; reason: string },
        ) =>
          withCsrf<IncidentSummary>(
            'staff',
            '/v1/admin/incidents/' + encodeURIComponent(reference) + '/owner',
            input,
          ),
        uploadAttachment: (reference: string, file: File) => {
          const form = new FormData();
          form.append('file', file, file.name);
          return withCsrfMultipart<IncidentAttachment>(
            'staff',
            '/v1/admin/incidents/' + encodeURIComponent(reference) + '/attachments',
            form,
          );
        },
        downloadAttachment: (reference: string, attachmentId: string) =>
          privateDownload(
            '/v1/admin/incidents/' +
              encodeURIComponent(reference) +
              '/attachments/' +
              encodeURIComponent(attachmentId) +
              '/download',
          ),
      },
      borders: {
        trip: (tripId: string) =>
          call<BorderTripView>('GET', '/v1/admin/borders/trips/' + encodeURIComponent(tripId)),
        record: (tripId: string, input: BorderEventInput) =>
          withCsrf<BorderEventResult>(
            'staff',
            '/v1/admin/borders/trips/' + encodeURIComponent(tripId) + '/events',
            input,
          ),
      },
      tracking: {
        trips: () => call<{ items: TrackingTripSummary[] }>('GET', '/v1/admin/tracking/trips'),
        trip: (tripId: string) =>
          call<TrackingTripDetail>('GET', '/v1/admin/tracking/trips/' + encodeURIComponent(tripId)),
        devices: () => call<{ items: TrackingDevice[] }>('GET', '/v1/admin/tracking/devices'),
        createDevice: (input: { vehicleId: string; providerKey: string; externalId: string }) =>
          withCsrf<TrackingDevice>('staff', '/v1/admin/tracking/devices', input),
        configure: (tripId: string, input: TrackingConfigInput) =>
          withCsrf<TrackingConfigMutationResult>(
            'staff',
            '/v1/admin/tracking/trips/' + encodeURIComponent(tripId) + '/config',
            input,
          ),
        observe: (tripId: string, input: TrackingObservationInput) =>
          withCsrf<TrackingObservationResult>(
            'staff',
            '/v1/admin/tracking/trips/' + encodeURIComponent(tripId) + '/observations',
            input,
          ),
        issueToken: (tripId: string, expiresAt?: string) =>
          withCsrf<TrackingIssuedToken>(
            'staff',
            '/v1/admin/tracking/trips/' + encodeURIComponent(tripId) + '/public-tokens',
            expiresAt ? { expiresAt } : {},
          ),
        revokeToken: (tripId: string, tokenId: string, reason: string) =>
          withCsrf<TrackingPublicTokenSummary>(
            'staff',
            '/v1/admin/tracking/trips/' +
              encodeURIComponent(tripId) +
              '/public-tokens/' +
              encodeURIComponent(tokenId) +
              '/revoke',
            { reason },
          ),
      },
      /**
       * PR-12: compliance.read / compliance.review for passengers;
       * compliance.rule.read / compliance.rule.manage for the rule catalogue.
       */
      compliance: {
        rules: (
          options: { cursor?: string; limit?: number; status?: ComplianceRuleVersionStatus } = {},
        ) =>
          call<Page<ComplianceRuleSummary>>(
            'GET',
            `/v1/admin/compliance/rules?${query({
              cursor: options.cursor,
              limit: options.limit,
              status: options.status,
            })}`,
          ),
        rule: (reference: string) =>
          call<ComplianceRule>(
            'GET',
            `/v1/admin/compliance/rules/${encodeURIComponent(reference)}`,
          ),
        createRule: (input: { title: string; version: ComplianceRuleVersionInput }) =>
          withCsrf<ComplianceRule>('staff', '/v1/admin/compliance/rules', input),
        createVersion: (reference: string, version?: ComplianceRuleVersionInput) =>
          withCsrf<ComplianceRule>(
            'staff',
            `/v1/admin/compliance/rules/${encodeURIComponent(reference)}/versions`,
            version ? { version } : {},
          ),
        updateVersion: (reference: string, version: number, input: ComplianceRuleVersionInput) =>
          withCsrf<ComplianceRule>(
            'staff',
            `/v1/admin/compliance/rules/${encodeURIComponent(reference)}/versions/${version}`,
            input,
          ),
        verifyVersion: (
          reference: string,
          version: number,
          input: { definitionSha256: string; sourceCheckedOn: string; note?: string },
        ) =>
          withCsrf<ComplianceRule>(
            'staff',
            `/v1/admin/compliance/rules/${encodeURIComponent(reference)}/versions/${version}/verify`,
            input,
          ),
        publishVersion: (reference: string, version: number, definitionSha256: string) =>
          withCsrf<ComplianceRule>(
            'staff',
            `/v1/admin/compliance/rules/${encodeURIComponent(reference)}/versions/${version}/publish`,
            { definitionSha256 },
          ),
        retireVersion: (reference: string, version: number, reason: string) =>
          withCsrf<ComplianceRule>(
            'staff',
            `/v1/admin/compliance/rules/${encodeURIComponent(reference)}/versions/${version}/retire`,
            { reason },
          ),
        queue: (options: ComplianceQueueOptions = {}) =>
          call<Page<ComplianceQueueItem>>(
            'GET',
            `/v1/admin/compliance/booking-passengers?${query({
              cursor: options.cursor,
              limit: options.limit,
              status: options.status,
              tripReference: options.tripReference,
              bookingReference: options.bookingReference,
              passengerReference: options.passengerReference,
              departureFrom: options.departureFrom,
              departureTo: options.departureTo,
            })}`,
          ),
        evaluation: (reference: string) =>
          call<ComplianceEvaluationDetail>(
            'GET',
            `/v1/admin/compliance/evaluations/${encodeURIComponent(reference)}`,
          ),
        evaluate: (bookingReference: string, passengerReference: string) =>
          withCsrf<{ reference: string; created: boolean }>(
            'staff',
            '/v1/admin/compliance/evaluations',
            { bookingReference, passengerReference },
          ),
        review: (evaluationReference: string, input: ComplianceReviewInput) =>
          withCsrf<{
            evaluationReference: string;
            review: { id: string; decision: ComplianceReviewDecision; reviewedAt: string };
          }>(
            'staff',
            `/v1/admin/compliance/evaluations/${encodeURIComponent(evaluationReference)}/reviews`,
            input,
          ),
      },
    },
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
