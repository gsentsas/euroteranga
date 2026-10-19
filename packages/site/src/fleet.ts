import type { AmenityIconName } from './icons.js';

/**
 * UI-PUBLIC-2: the coaches as the public fleet read describes them (Fleet).
 * Names, models, seats and on-board equipment are never written in the CMS;
 * the CMS only adds photographs and a description per vehicle.
 */

export type SiteAmenity =
  | 'AIR_CONDITIONING'
  | 'RECLINING_SEATS'
  | 'USB_CHARGING'
  | 'WIFI'
  | 'TOILET'
  | 'ENTERTAINMENT'
  | 'WHEELCHAIR_ACCESS';

/** Canonical order of the API, with the traveller-facing label and icon. */
export const AMENITIES: Record<SiteAmenity, { label: string; icon: AmenityIconName }> = {
  AIR_CONDITIONING: { label: 'Climatisation', icon: 'snowflake' },
  RECLINING_SEATS: { label: 'Sièges inclinables', icon: 'recline' },
  USB_CHARGING: { label: 'Prises USB', icon: 'plug' },
  WIFI: { label: 'Wi-Fi à bord', icon: 'wifi' },
  TOILET: { label: 'Toilettes', icon: 'toilet' },
  ENTERTAINMENT: { label: 'Divertissement à bord', icon: 'screen' },
  WHEELCHAIR_ACCESS: { label: 'Accès fauteuil roulant', icon: 'wheelchair' },
};

/** Known equipment only: a value added later to the API is ignored, not shown raw. */
export function knownAmenities(values: readonly string[]): SiteAmenity[] {
  return values.filter((value): value is SiteAmenity => value in AMENITIES);
}

/** An active vehicle (no VIN, plate or status). */
export interface SiteVehicle {
  code: string;
  name: string | null;
  manufacturer: string;
  model: string;
  modelYear: number | null;
  amenities: SiteAmenity[];
  /** Seats of its current seat map; null without one. */
  seatCount: number | null;
}

/** Active vehicles; null when the fleet read could not answer. */
export type FleetLookup = readonly SiteVehicle[] | null;

/** The public name: the operational name ("Teranga 01"), else the model. */
export const vehicleTitle = (vehicle: Pick<SiteVehicle, 'name' | 'manufacturer' | 'model'>) =>
  vehicle.name ?? `${vehicle.manufacturer} ${vehicle.model}`;

/** "Setra S 517 HDH · 2023". */
export const vehicleModelLine = (vehicle: SiteVehicle) =>
  `${vehicle.manufacturer} ${vehicle.model}${vehicle.modelYear ? ` · ${vehicle.modelYear}` : ''}`;

/** Anchor of a vehicle on the page (codes are unique). */
export const vehicleAnchor = (code: string) => `autocar-${code.toLowerCase()}`;

export interface FleetPresentation {
  vehicleCode: string;
  mediaId?: string | undefined;
  description?: string | undefined;
  gallery: readonly string[];
}

/**
 * Vehicles to show: with `listed`, the presented ones in the editor's order;
 * with `all`, those first and then every other active vehicle. A presented
 * vehicle that is not active (or unknown) is left out.
 */
export function fleetVehicles(
  selection: 'all' | 'listed',
  items: readonly FleetPresentation[],
  fleet: FleetLookup,
): Array<{ vehicle: SiteVehicle; presentation: FleetPresentation | undefined }> {
  if (!fleet) return [];
  const byCode = new Map(fleet.map((vehicle) => [vehicle.code, vehicle]));
  const shown = items.flatMap((presentation) => {
    const vehicle = byCode.get(presentation.vehicleCode);
    return vehicle ? [{ vehicle, presentation }] : [];
  });
  if (selection === 'listed') return shown;
  const presented = new Set(shown.map((entry) => entry.vehicle.code));
  return [
    ...shown,
    ...fleet
      .filter((vehicle) => !presented.has(vehicle.code))
      .map((vehicle) => ({ vehicle, presentation: undefined })),
  ];
}
