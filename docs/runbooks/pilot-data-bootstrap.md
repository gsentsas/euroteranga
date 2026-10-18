# Pilot data bootstrap (DATA-1)

`pnpm data:bootstrap-pilot` initializes the pilot dataset of the Paris ↔
Dakar corridor, so that an environment has bookable trips without anyone
typing them into OPS or writing SQL.

## What it creates

| Category  | Records                                                                                                                                                                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference | Countries FR, ES, MA, MR and SN (ISO 3166-1); stops `PAR` Paris and `DKR` Dakar (city-level coordinates, IANA time zones).                                                                                                                                                        |
| Pilot     | Five operational checkpoints:<br>• `CP-FR-ES-BIRIATOU`: border;<br>• `CP-ES-ALGECIRAS`: ferry terminal;<br>• `CP-MA-TANGER-MED`: port;<br>• `CP-MR-NORD`: border;<br>• `CP-MR-SN-ROSSO`: border.                                                                                  |
| Pilot     | Routes `ET-PAR-DKR` and `ET-DKR-PAR`, one published version each: the first stop allows boarding only, the last allows alighting only, and the checkpoints sit in between.                                                                                                        |
| Pilot     | Seat map `ET-SM-COACH-53` "(pilote)": one deck with a driver, a front door and a middle door, an aisle, a toilet and 53 numbered seats (`1A` to `12D`, back bench `13A` to `13E`).                                                                                                |
| Pilot     | Coaches:<br>• `ET-COACH-001` « Teranga 01 »;<br>• `ET-COACH-002` « Teranga 02 ».<br>Both are Setra S 516 HD, `ACTIVE`, on the pilot seat map, with plates `DEMO-ET-001` and `DEMO-ET-002`, and no VIN.                                                                            |
| Pilot     | Fare tables `ET-FT-PAR-DKR-EUR` and `ET-FT-DKR-PAR-EUR`: 249,00 EUR (`24900` minor units) from the first stop to the last.                                                                                                                                                        |
| Pilot     | Future trips `ET-PILOT-<PARDKR or DKRPAR>-<YYYYMMDD>`:<br>• departures every 14 days from the anchor date (J+14, J+28…), 08:00 local time at the departure stop;<br>• both coaches alternate directions;<br>• every trip is `SCHEDULED` with its historical seat map and pricing. |

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
- **Idempotent:** an existing record that matches the pilot definition is
  reused.
- **Resumable:**
  - a vehicle created but not yet configured is completed;
  - an empty draft route, seat-map or fare version is filled and published.
- **Never overwrites:** a record that differs from the definition is left
  untouched and reported as `conflict`. Everything that depends on it is
  `skipped`, and the command exits with code 2. Examples:
  - a route published with other waypoints;
  - a vehicle on another seat map, or `OUT_OF_SERVICE`;
  - a fare table in another currency.
- **Trips:**
  - when a direction already has at least `--trips-per-direction` upcoming
    `SCHEDULED` pilot departures, nothing is added;
  - a later run never stacks a second set;
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
