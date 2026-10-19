import type { RealisticOutcome, RealisticReportLine } from './realistic-seed.js';

/** Report entities in seed order, with the label of the summary table. */
const ENTITY_LABELS: ReadonlyArray<[entity: string, label: string]> = [
  ['country', 'Countries'],
  ['stop', 'Stops'],
  ['checkpoint', 'Checkpoints'],
  ['route', 'Routes'],
  ['seat-map', 'Seat maps'],
  ['vehicle', 'Vehicles'],
  ['amenities', 'Equipment'],
  ['fare-table', 'Fare tables'],
  ['trip', 'Trips'],
  // The pilot reports a whole direction at once when it has enough departures.
  ['trips', 'Trip series'],
  ['page', 'Pages'],
  ['navigation', 'Navigation'],
];

const COLUMNS: readonly RealisticOutcome[] = [
  'created',
  'updated',
  'existing',
  'planned',
  'skipped',
  'conflict',
];

/**
 * "Vehicles     created=1 updated=2 existing=0 …": one row per entity, in
 * seed order, then any entity the table does not know yet.
 */
export function summarize(lines: readonly RealisticReportLine[]): string[] {
  const known = new Map(ENTITY_LABELS);
  const entities = [
    ...ENTITY_LABELS.map(([entity]) => entity),
    ...new Set(lines.map((line) => line.entity).filter((entity) => !known.has(entity))),
  ];
  return entities
    .filter((entity) => lines.some((line) => line.entity === entity))
    .map((entity) => {
      const counts = COLUMNS.map(
        (outcome) =>
          `${outcome}=${lines.filter((line) => line.entity === entity && line.outcome === outcome).length}`,
      );
      return `${(known.get(entity) ?? entity).padEnd(13)} ${counts.join(' ')}`;
    });
}
