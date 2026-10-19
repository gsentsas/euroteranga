import type { PrismaClient } from '@euroteranga/database';
import type { z } from 'zod';
import type { vehicleCreateSchema } from './fleet.dto.js';

type VehicleCreate = z.infer<typeof vehicleCreateSchema>;

/**
 * The first unique identifier of a vehicle about to be created (or renamed)
 * that another vehicle already holds, as the database would refuse it:
 * code, name, VIN, then the registration country and plate, the four unique
 * keys of `vehicle`. The candidate is the output of `vehicleCreateSchema`,
 * so values are normalized as the fleet service stores them. The vehicle
 * itself (`exceptVehicleId`) is not a collision.
 *
 * Bootstraps run it before deciding between `planned` (dry run) and a
 * write, so a dry run never announces a creation the fleet service would
 * then refuse with VEHICLE_IDENTIFIER_CONFLICT. The service stays the last
 * barrier. The reason names the other vehicle by its code only and never
 * prints its VIN; the name and plate shown are the candidate's own.
 */
export async function vehicleIdentifierCollision(
  db: PrismaClient,
  candidate: Pick<
    VehicleCreate,
    'code' | 'name' | 'vin' | 'registrationPlate' | 'registrationCountryId'
  >,
  options: { exceptVehicleId?: string } = {},
): Promise<string | null> {
  const name = candidate.name ?? null;
  const vin = candidate.vin ?? null;
  const plate = candidate.registrationPlate ?? null;
  const countryId = candidate.registrationCountryId ?? null;
  const others = await db.vehicle.findMany({
    where: {
      OR: [
        { code: candidate.code },
        ...(name !== null ? [{ name }] : []),
        ...(vin !== null ? [{ vin }] : []),
        ...(plate !== null && countryId !== null
          ? [{ registrationCountryId: countryId, registrationPlate: plate }]
          : []),
      ],
      ...(options.exceptVehicleId ? { NOT: { id: options.exceptVehicleId } } : {}),
    },
    orderBy: { code: 'asc' },
    select: {
      code: true,
      name: true,
      vin: true,
      registrationPlate: true,
      registrationCountryId: true,
      registrationCountry: { select: { iso2: true } },
    },
  });
  if (others.some((other) => other.code === candidate.code)) {
    return `vehicle code ${candidate.code} already belongs to another vehicle`;
  }
  const byName = name !== null ? others.find((other) => other.name === name) : undefined;
  if (byName) return `vehicle name "${name}" already belongs to ${byName.code}`;
  const byVin = vin !== null ? others.find((other) => other.vin === vin) : undefined;
  if (byVin) return `VIN already belongs to ${byVin.code}`;
  const byRegistration =
    plate !== null && countryId !== null
      ? others.find(
          (other) => other.registrationCountryId === countryId && other.registrationPlate === plate,
        )
      : undefined;
  if (byRegistration) {
    const country = byRegistration.registrationCountry?.iso2 ?? '?';
    return `registration ${country}/${plate} already belongs to ${byRegistration.code}`;
  }
  return null;
}
