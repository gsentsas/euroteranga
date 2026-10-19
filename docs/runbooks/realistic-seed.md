# Realistic demonstration dataset (SEED-REALISTIC-1)

`pnpm seed:realistic` makes EURO TERANGA look operated: departures, fares,
itineraries and coaches on the public website, and, in local and CI
environments, customers, bookings, payments, bags, crew and operational notes
in OPS, Booking and Client.

It is stacked on the DATA-1 pilot bootstrap
([pilot-data-bootstrap.md](pilot-data-bootstrap.md)): the pilot corridor runs
first, then the demonstration layers. Everything goes through the domain
services, with their validation, transactions and audit, as the
`realistic-seed` system actor (`metadata.systemActor`). Nothing bypasses an
invariant, disables a constraint or writes SQL.

## Layers

| Layer      | Where                                      | What                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalogue  | everywhere (production only when approved) | The pilot corridor (5 countries, Paris and Dakar, 5 checkpoints, 2 routes, the 53-seat map, Teranga Pilote 01 and 02, fares, 6 departures per direction), plus: a 49-seat map with a wheelchair space, Teranga 03 (PLANNED), DEMO on-board equipment, the four UI-PUBLIC-2 pages from their templates (published, never indexed) and a public navigation without dead links. |
| Commerce   | local and CI only (SANDBOX payments)       | 40 synthetic customers, 40 bookings (about 85 % and 30 % full Paris → Dakar, 60 % and 6 % Dakar → Paris), 37 SANDBOX payments succeeded, 1 pending, 1 declined, 1 hold cancelled, 98 fictitious passengers.                                                                                                                                                                  |
| Operations | local and CI only, with commerce           | The seed's operator identity, 4 crew members and 8 crew duties, about 60 bags declared online, checkpoint tracking and two LOW notes on the soonest departures.                                                                                                                                                                                                              |

SANDBOX payments are refused by configuration in staging and production, and
passengers can only be added to a paid booking: there, the commerce and
operations layers report themselves as skipped.

### Not seeded, on purpose

- **Check-in, boarding, manifests, departures and past trips.** Check-in
  needs each passenger's documents to be verified or a compliance decision;
  a manifest lists checked-in passengers; a departure needs both. The seed
  never fabricates a document, a compliance review or a permit. Past trips
  with passengers cannot be created through the domain either (a trip is
  booked only before its departure): history appears as the seeded trips go
  by, in OPS.
- **Tracking tokens and positions.** An operator issues a tracking link from
  OPS; no synthetic GPS position is ever recorded.
- **Intermediate boarding stops.** They would need segment fares, which are
  commercial data.
- **Photos.** The media library keeps only images whose rights are known: the
  coach pages show the coach illustration until real photos are uploaded.

## Identification

| Records                                               | How to recognise them                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Pilot corridor                                        | DATA-1 codes (`ET-COACH-*`, `ET-PILOT-*`, `DEMO-*` plates), audited by `pilot-bootstrap` |
| Teranga 03, 49-seat map, equipment, pages, navigation | `ET-COACH-003`, `ET-SM-COACH-49`, audited by `realistic-seed`                            |
| Customers, crew, operator                             | reserved addresses `etr-v1-*@example.test`, no password, no role                         |
| Payments                                              | provider `SANDBOX`, events `evt_seed_*`, idempotency keys `seed-pay-*`                   |
| Passengers                                            | a given name and an initial (`Awa D.`), synthetic dates of birth                         |
| Incidents                                             | client event ids `seed-etr-v1-*`, descriptions ending with "(donnée de démonstration)"   |

Namespace: `ET_REALISTIC_V1`, on the pilot dataset `pilot-corridor/3`. The
make, model and year of the coaches stay neutral ("Autocar grand tourisme",
"Modèle à confirmer") until the owner provides them.

The seeded coaches are named « Teranga Pilote 01 », « Teranga Pilote 02 »
and « Teranga 03 ». The names « Teranga 01 » and « Teranga 02 » may belong to
historical operator vehicles (on the pilot server, `ET-BUS-001` and
`ET-BUS-002`, retired): they are never taken over, renamed, reactivated or
changed. See [pilot-data-bootstrap.md](pilot-data-bootstrap.md).

## Commands

The command runs the built API (`apps/api/dist`) inside the API's own
application context (same configuration and providers, no HTTP server), with
the target's API environment. It prints the database target masked, and
never a secret.

```bash
pnpm seed:realistic -- --dry-run
```

```bash
ALLOW_REALISTIC_SEED=true pnpm seed:realistic -- --apply
```

```bash
pnpm seed:realistic -- --summary
```

```bash
pnpm seed:realistic -- --cleanup-seed-only --dry-run
```

```bash
ALLOW_REALISTIC_SEED=true pnpm seed:realistic -- --cleanup-seed-only
```

| Option                                         | Meaning                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| (none) or `--dry-run`                          | Read only: what exists, what would be created, conflicts and skipped layers.                    |
| `--apply`                                      | Writes. Needs `ALLOW_REALISTIC_SEED=true`.                                                      |
| `--summary`                                    | Read only: the summary table alone.                                                             |
| `--cleanup-seed-only` (`--dry-run` to preview) | Retires the seed's own records (see below). Needs `ALLOW_REALISTIC_SEED=true` unless previewed. |
| `--anchor-date`, `--trips-per-direction`       | As the pilot bootstrap (today, 6).                                                              |
| `--confirm-production`                         | Required, with `ALLOW_REALISTIC_SEED=true`, to write when `APP_ENV=production`.                 |

`REALISTIC_SEED_NAMESPACE`, when set, must be `ET_REALISTIC_V1`. Exit codes:
`0` done, `2` refused or conflicts, `1` error.

## Idempotence

- Matching records are reused (`existing`); a step missing from an
  interrupted run is completed; anything else is a `conflict`, left untouched,
  and what depends on it is skipped. Operator navigation, pages and equipment
  are never replaced.
- A departure that already has seed bookings keeps the plan it was first
  seeded with (its customers' addresses name it). Its complete bookings are
  kept as they are. A booking, or a step of one (payment, its result,
  passengers), that an interrupted run left out is completed from where it
  stopped, by the same synthetic customer. A hold that expired before it was
  completed is a conflict, left as it is. No booking is ever made twice, so a
  second run, or a run weeks later, never piles bookings up.
- A departure without seed bookings gets the plan of its position: as earlier
  departures leave, a later run books the next ones.
- A second run on the same day writes nothing (no row, no audit event): the
  integration tests compare every table and the audit trail.

### A dry run predicts the write

- Before a coach is planned or created, its four unique keys (code, name,
  VIN, registration country and plate) are checked against every other
  vehicle, with the same code in a dry run and in a write. A key held by
  another vehicle is a `conflict` naming that vehicle's code, for example
  `vehicle name "Teranga 03" already belongs to OPS-003`, never `planned`.
- What depends on a conflict (equipment, trips) is `skipped` in both modes.
- So a dry run without conflict means the write will not meet
  `VEHICLE_IDENTIFIER_CONFLICT` on data already in the database. The fleet
  service stays the last barrier.

### Resuming after a partial apply

On 2026-10-19, the first production apply (dataset `pilot-corridor/2`)
stopped on `VEHICLE_IDENTIFIER_CONFLICT` for `ET-COACH-001` and
`ET-COACH-002`. Their names, « Teranga 01 » and « Teranga 02 », belonged to
the retired operator coaches `ET-BUS-001` and `ET-BUS-002`. The dry run
before it had planned them: it checked only codes. Everything before them
was created (checkpoints, routes, both seat maps, fare tables, Teranga 03
and its equipment); the coaches, their equipment and the 12 trips were not.

With `pilot-corridor/3`, from a release that contains it:

1. Run the dry run. Expect:
   - `existing`: countries, stops, checkpoints, routes, both seat maps, fare
     tables, `ET-COACH-003`, the four pages ("published (kept)") and the
     navigation ("operator navigation kept");
   - `planned`: `ET-COACH-001` « Teranga Pilote 01 », `ET-COACH-002`
     « Teranga Pilote 02 », their equipment and the 12 trips;
   - `conflict`: 0.
2. Only with the owner's written approval of that dry run, apply with the
   same anchor date (see [Production](#production)).
3. A second dry run reports everything `existing`.

The anchor date cannot be in the past (UTC day). If the date of the first
attempt has passed, run and approve a dry run with a new date: no trip was
created yet, so the new date only moves the planned departures.

## Cleanup (`--cleanup-seed-only`)

Nothing is deleted: vehicles, trips and bookings cannot be, by design. The
cleanup retires, through the domain, what the audit trail proves the seed
created and no person changed since:

- pages archived; the navigation published back to the default one;
- Teranga 03 retired; the 49-seat map deactivated;
- the DEMO equipment removed, if it is still exactly the seed's;
- open seed holds cancelled.

It keeps, and reports:

- anything a person edited (operator data);
- confirmed seed bookings, with their passengers, bags and crew duties: a paid
  booking is cancelled only after a refund. They exist only in disposable
  local or CI databases: drop the database;
- the pilot corridor (DATA-1): cancel its trips in OPS, as its runbook says.

A second cleanup finds nothing more to retire. A retired coach cannot be
re-seeded under the same code: to start again, restore the database backup
and run the seed again.

## Production

The catalogue layer is the only one that can ever run in production. It is
never run automatically, and never without the owner's explicit approval
after review. Before approval, the owner checks:

- the pilot assumptions (timetable, 249 EUR fare, checkpoints) and the DEMO
  equipment, which the public website will show;
- that the four pages stay `noindex` and out of the sitemap (the seed never
  changes indexing).

Procedure, as the application user, from the current release, with the API
environment file:

1. Take and verify a database backup.
2. Choose the anchor date (`YYYY-MM-DD`, today or later) and run the dry run
   with it, so that the approved report names the exact departures:

   ```bash
   sudo -u euroteranga.com_5p804yhows7 bash -c 'set -a; . /var/www/vhosts/euroteranga.com/.secrets/api.env; set +a; cd /var/www/vhosts/euroteranga.com/current && pnpm seed:realistic -- --dry-run --anchor-date YYYY-MM-DD'
   ```

3. Only with the owner's written approval of that dry run, add
   `ALLOW_REALISTIC_SEED=true` for this command only and run it with
   `--apply --confirm-production --anchor-date` and **the same date**. Without
   it, a later day would plan other departures than the approved ones. If the
   approved date is already in the past, run and approve a new dry run.
4. Check `/v1/booking/fleet`, `/paris-dakar`, `/dakar-paris`, `/nos-bus` and
   `/services`, and that the pages are still `noindex`.

Rollback: `--cleanup-seed-only` (preview first), then cancel the pilot trips
in OPS; or restore the backup taken in step 1.
