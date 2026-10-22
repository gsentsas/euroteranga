# Trip operational costs

TRIP-COST-1 adds an internal, pre-departure cost plan to the existing `Trip`.
It answers how much a trip is expected to cost to operate. It does not price
tickets, recognize revenue, calculate contribution or decide whether a convoy
or support vehicle should leave.

## Model and exact money

Each trip has at most one `TripCostPlan`. A plan owns zero to one hundred
ordered `TripCostItem` rows. Every amount is a non-negative integer in minor
units (`1600000` means EUR 16,000.00); neither PostgreSQL, the API nor OPS uses
floating-point money. The response total is always the server-side sum of the
stored lines. Clients cannot submit a total.

TRIP-COST-1 accepts only EUR with minor unit 2. The plan stores currency shape
explicitly so a later design can add currencies, but this module performs no
foreign-exchange conversion and calls no rate provider.

The strict categories are `FUEL`, `TOLLS`, `FERRY`, `BORDER_FEES`, `PERMITS`,
`DRIVERS`, `ACCOMMODATION`, `MEALS_ALLOWANCES`, `MAINTENANCE`, `INSURANCE`,
`CLEANING_PREPARATION`, `PARKING`, `STOP_COST`, `SUPPORT_VEHICLE`,
`CONTINGENCY` and `OTHER`. A `STOP_COST` or `SUPPORT_VEHICLE` line is entered
explicitly; no stop, capacity, regulatory or convoy rule generates it.

## Lifecycle

- `DRAFT`: incomplete and editable.
- `ESTIMATED`: operational estimate, still editable.
- `LOCKED`: terminal snapshot. The API and PostgreSQL reject changes to the
  plan or its lines.

A semantically identical full replacement is a no-op: no timestamp changes
and no audit event is written. Any meaningful replacement writes the status,
ordered lines and `TRIP_COST_UPDATED` audit snapshot in one transaction. A
failed audit insert rolls the entire replacement back.

Plans and items cannot be deleted directly. Items are replaced only while the
plan is editable; a trip with a plan remains protected by the trip foreign key.
PostgreSQL also checks amount range, EUR/minor-unit shape, normalized labels/notes,
position range and unique line order.

## Internal API and authorization

Both routes are under `/v1/admin/trips/:tripId/costs`:

| Method | Permission    | Behaviour                                    |
| ------ | ------------- | -------------------------------------------- |
| GET    | `trip.read`   | Read the plan or its virtual empty EUR draft |
| POST   | `trip.manage` | Atomically replace status and all lines      |

The mutation also requires the STAFF session's CSRF token. Existing Trip
permissions are sufficient, so TRIP-COST-1 adds no permission. OPS renders an
editable French section for `trip.manage` and a read-only section for
`trip.read`.

The public booking, tracking and customer projections never join or serialize
trip cost plans. Operational costs remain strictly internal.

## Deliberate exclusions

There are no hard-coded EUR 16,000/32,000/58,000 assumptions, automatic fuel
or stop estimates, driver-law rules, Maps API, FX, cargo pricing, revenue,
margin, accounting export, profitability signal or dispatch decision. Those
belong to later domains such as CONVOY-1, CARGO-1 and OPS-PROFIT-1.
