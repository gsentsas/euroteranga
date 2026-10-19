import { PublicApiError } from '../../auth/http/public-api-error.js';

export type RealisticLayer = 'catalogue' | 'commerce';

export type RealisticOutcome =
  'created' | 'updated' | 'existing' | 'planned' | 'skipped' | 'conflict';

export interface RealisticReportLine {
  layer: RealisticLayer;
  outcome: RealisticOutcome;
  entity: string;
  key: string;
  detail?: string;
  /** Records the line stands for (several passengers of one booking); 1 by default. */
  count?: number;
}

/** An existing record differs from the seed definition: never overwritten. */
export class RealisticConflict extends Error {}

/**
 * The run report, shared by the layers: one line per item, and the items a
 * conflict or a skip blocks, so that whatever depends on them is skipped.
 */
export class RealisticReporter {
  readonly lines: RealisticReportLine[] = [];
  private readonly blockedKeys = new Set<string>();

  report(line: RealisticReportLine) {
    this.lines.push(line);
  }

  block(entity: string, key: string) {
    this.blockedKeys.add(`${entity}:${key}`);
  }

  blocked(entity: string, key: string): boolean {
    return this.blockedKeys.has(`${entity}:${key}`);
  }

  get hasConflicts(): boolean {
    return this.lines.some((line) => line.outcome === 'conflict');
  }

  /** Runs one item unless a dependency is blocked; a conflict blocks the item itself. */
  async guarded<R>(
    layer: RealisticLayer,
    entity: string,
    key: string,
    dependsOn: readonly string[],
    work: () => Promise<R | null>,
  ): Promise<R | null> {
    const missing = dependsOn.find((dependency) => this.blockedKeys.has(dependency));
    if (missing) {
      this.block(entity, key);
      this.report({ layer, outcome: 'skipped', entity, key, detail: `depends on ${missing}` });
      return null;
    }
    try {
      return await work();
    } catch (error) {
      this.block(entity, key);
      if (error instanceof RealisticConflict) {
        this.report({ layer, outcome: 'conflict', entity, key, detail: error.message });
        return null;
      }
      if (error instanceof PublicApiError) {
        this.report({
          layer,
          outcome: 'conflict',
          entity,
          key,
          detail: `${error.code}: ${error.publicMessage}`,
        });
        return null;
      }
      throw error;
    }
  }
}

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
  ['customer', 'Customers'],
  ['booking', 'Bookings'],
  ['payment', 'Payments'],
  ['passenger', 'Passengers'],
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
 * seed order, then any entity the table does not know yet. A line counts
 * for the records it stands for.
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
      const counts = COLUMNS.map((outcome) => {
        const total = lines
          .filter((line) => line.entity === entity && line.outcome === outcome)
          .reduce((sum, line) => sum + (line.count ?? 1), 0);
        return `${outcome}=${total}`;
      });
      return `${(known.get(entity) ?? entity).padEnd(13)} ${counts.join(' ')}`;
    });
}
