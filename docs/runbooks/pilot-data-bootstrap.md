# Pilot data bootstrap (DATA-1)

`pnpm data:bootstrap-pilot` initializes the pilot dataset of the Paris ↔
Dakar corridor, so that an environment has bookable trips without anyone
typing them into OPS or writing SQL.

## What it creates

| Category  | Records                                                                                                                                                                                                                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference | Countries FR, ES, MA, MR and SN (ISO 3166-1); stops `PAR` Paris and `DKR` Dakar (city-level coordinates, IANA time zones).                                                                                                                                                                                                    |
| Pilot     | Five operational checkpoints:<br>• `CP-FR-ES-BIRIATOU`: border;<br>• `CP-ES-ALGECIRAS`: ferry terminal;<br>• `CP-MA-TANGER-MED`: port;<br>• `CP-MR-NORD`: border;<br>• `CP-MR-SN-ROSSO`: border.                                                                                                                              |
| Pilot     | Routes `ET-PAR-DKR` and `ET-DKR-PAR`, one published version each: the first stop allows boarding only, the last allows alighting only, and the checkpoints sit in between.                                                                                                                                                    |
| Pilot     | Seat map `ET-SM-COACH-53` "(pilote)": one deck with a driver, a front door and a middle door, an aisle, a toilet and 53 numbered seats (`1A` to `12D`, back bench `13A` to `13E`).                                                                                                                                            |
| Pilot     | Coaches:<br>• `ET-COACH-001` « Teranga 01 »;<br>• `ET-COACH-002` « Teranga 02 ».<br>Both are `ACTIVE`, on the pilot seat map, with plates `DEMO-ET-001` and `DEMO-ET-002`, and no VIN. Their make and model stay neutral ("Autocar grand tourisme", "Modèle à confirmer", no year) until the owner confirms the real coaches. |
| Pilot     | Fare tables `ET-FT-PAR-DKR-EUR` and `ET-FT-DKR-PAR-EUR`: 249,00 EUR (`24900` minor units) from the first stop to the last.                                                                                                                                                                                                    |
| Pilot     | Future trips `ET-PILOT-<PARDKR or DKRPAR>-<YYYYMMDD>`:<br>• departures every 14 days from the anchor date (J+14, J+28…), 08:00 local time at the departure stop;<br>• both coaches alternate directions;<br>• every trip is `SCHEDULED` with its historical seat map and pricing.                                             |

Pilot records are fictitious and clearly marked:

- codes `ET-COACH-*` and `ET-PILOT-*`;
- plates `DEMO-*`;
- seat-map name "(pilote)".

The dataset contains no real person, document, address or vehicle
identifier. Positions, timetable and fare are **pilot assumptions** for
operations and the owner to confirm (audit blocker B6). Checkpoints are
operational points only: they make no regulatory, customs or legal claim.

The bootstrap does not set up:

- passengers, bookings or payments;
- crew assignments, permit policies or departure authorizations;
- tracking configuration.

Each of these stays an explicit OPS action on a pilot trip.

## How it works

- **Same rules as OPS:** every write goes through the domain services, with
  the same validation, the same transactions and the same audit events as an
  OPS action. Each step is atomic.
- **System actor:** writes are audited with `actor_identity_id = NULL` and
  `metadata.systemActor = "pilot-bootstrap"`.
- **Fail-closed reuse.** Each existing record falls into one of three cases:

  | Existing record                                                           | Outcome     |
  | ------------------------------------------------------------------------- | ----------- |
  | Identical to the pilot definition                                         | `existing`  |
  | Compatible, missing only a step the bootstrap performs itself (see below) | `completed` |
  | Anything else                                                             | `conflict`  |

  The steps the bootstrap performs itself are:
  - assigning the seat map to a vehicle that has none;
  - activating a `PLANNED` vehicle;
  - filling an empty draft version;
  - finishing a draft trip of one of the run's slots whose values are all
    pilot values.

- **Never overwrites:** a conflicting record is left untouched. Everything
  that depends on it is `skipped`, and the command exits with code 2. The
  integration tests compare the record before and after, audit included.
- **Comparison per entity:**

  | Entity     | Must match (otherwise `conflict`)                                                                                                                            | Operator values kept     |
  | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
  | Country    | ISO3; active                                                                                                                                                 | display name             |
  | Stop       | country; time zone (it drives the local timetable); active                                                                                                   | name, locality, position |
  | Checkpoint | country; type; time zone; active                                                                                                                             | name, locality, position |
  | Route      | the published waypoints (order, places, boarding and alighting)                                                                                              | —                        |
  | Seat map   | the published cells                                                                                                                                          | —                        |
  | Vehicle    | name, manufacturer, model, year, registration plate and country, no VIN; not `OUT_OF_SERVICE` or `RETIRED`; same seat map if one is set                      | —                        |
  | Fare table | route, currency, the published fare for the pilot route version                                                                                              | —                        |
  | Pilot trip | route version, a pilot coach, seat map, fare table, a departure matching its reference date at 08:00 local time, and the pilot timetable from that departure | —                        |

- **Trips:**
  - every upcoming pilot trip of a direction must match before it is
    counted;
  - a single divergent trip (for example moved by OPS to another coach)
    blocks the direction: it is reported, nothing is added next to it, and
    the trip itself is untouched;
  - a draft pilot trip from another run is a conflict, to be completed or
    cancelled in OPS;
  - when a direction already has `--trips-per-direction` upcoming pilot
    departures, nothing is added, so a later run never stacks a second set;
  - a slot whose coach already serves an overlapping trip is reported as a
    conflict before anything is written (FLEET-1 also refuses it in the API
    and in PostgreSQL).

## Usage

The command runs the built API (`apps/api/dist`), with the API environment of
the target (`DATABASE_URL`, `APP_ENV`, …). It prints business codes only,
never the connection string or any secret.

```bash
pnpm data:bootstrap-pilot -- --dry-run
```

```bash
pnpm data:bootstrap-pilot
```

| Option                  | Default     | Meaning                                                      |
| ----------------------- | ----------- | ------------------------------------------------------------ |
| `--dry-run`             | off         | Read only: lists `existing` and `planned` items.             |
| `--anchor-date`         | today (UTC) | First departures at anchor + 14 days. Cannot be in the past. |
| `--trips-per-direction` | `4`         | 1 to 8 upcoming departures per direction.                    |
| `--confirm-production`  | off         | Required to write when `APP_ENV=production`.                 |

Exit codes:

- `0`: done;
- `2`: refused, invalid arguments or at least one conflict;
- `1`: error.

## Production

The command refuses to write when `APP_ENV=production`, unless
`--confirm-production` is given. A dry run is always allowed. Before
confirming, the owner decides that pilot trips may appear in the public
Booking site.

While `PAYMENT_PROVIDER=DISABLED`, no booking on them can be confirmed.
Customers can still place temporary holds.

On the pilot server, run it as the application user, from the current
release, with the API environment file:

```bash
sudo -u euroteranga.com_5p804yhows7 bash -c 'set -a; . /var/www/vhosts/euroteranga.com/.secrets/api.env; set +a; cd /var/www/vhosts/euroteranga.com/current && pnpm data:bootstrap-pilot -- --dry-run'
```

Review the dry run, then run it again with `--confirm-production`. Pilot
trips are retired like any other trip: cancel them in OPS, with a reason.
