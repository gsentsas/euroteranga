import type { Prisma } from '@euroteranga/database';

export const cargoQuoteInclude = {
  lines: { orderBy: { position: 'asc' as const } },
  createdBy: { select: { id: true, email: true } },
  issuedBy: { select: { id: true, email: true } },
  acceptedBy: { select: { id: true, email: true } },
  cancelledBy: { select: { id: true, email: true } },
} as const satisfies Prisma.RoadFreightQuoteInclude;

type CargoQuoteRow = Prisma.RoadFreightQuoteGetPayload<{ include: typeof cargoQuoteInclude }>;

export function cargoQuoteView(row: CargoQuoteRow) {
  let charges = 0n;
  let discounts = 0n;
  const lines = row.lines.map((line) => {
    if (line.kind === 'CHARGE') charges += line.amountMinor;
    else discounts += line.amountMinor;
    return {
      id: line.id,
      kind: line.kind,
      label: line.label,
      amountMinor: line.amountMinor.toString(),
      notes: line.notes,
      position: line.position,
    };
  });

  return {
    reference: row.reference,
    version: row.version,
    status: row.status,
    currencyCode: row.currencyCode,
    currencyMinorUnit: row.currencyMinorUnit,
    totalMinor: (charges - discounts).toString(),
    snapshot: {
      direction: row.snapshotDirection,
      weightKg: row.snapshotWeightKg.toFixed(3),
      volumeLiters: row.snapshotVolumeLiters,
      packageCount: row.snapshotPackageCount,
      fragile: row.snapshotFragile,
      professional: row.snapshotProfessional,
      pickupRequired: row.snapshotPickupRequired,
      deliveryRequired: row.snapshotDeliveryRequired,
      shipmentUpdatedAt: row.shipmentUpdatedAt,
    },
    lines,
    createdBy: { id: row.createdBy.id, email: row.createdBy.email },
    issuedBy: row.issuedBy ? { id: row.issuedBy.id, email: row.issuedBy.email } : null,
    acceptedBy: row.acceptedBy ? { id: row.acceptedBy.id, email: row.acceptedBy.email } : null,
    cancelledBy: row.cancelledBy ? { id: row.cancelledBy.id, email: row.cancelledBy.email } : null,
    issuedAt: row.issuedAt,
    acceptedAt: row.acceptedAt,
    cancelledAt: row.cancelledAt,
    supersededAt: row.supersededAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
