# Operational reporting (PR-23)

PR-23 adds read-mostly operational reporting to OPS. The Core API remains the
business authority: the browser never reads PostgreSQL and never recomputes
financial totals. Reporting is calculated on demand from the authoritative
trip, booking, payment, finance, incident, baggage and fleet tables. There is
no reporting snapshot table, data warehouse or implicit FX conversion.

## Period and filters

The default reporting period is the half-open interval **`[from,to)` applied to
`trip.plannedDepartureAt`**. This deliberately measures the planned operating
calendar rather than record creation time. `from` and `to` are offset-aware ISO
instants; a request is rejected when `to <= from` or the interval exceeds 366
days. Optional filters are route, trip, vehicle and trip status.

The service refuses a result set above 5,000 trips and asks the caller to
narrow the period/filter. Lists returned inside the overview are bounded:
route performance is capped at 20 historical route versions and recent trips
at 25. Route reporting groups by `RouteVersion`, so a later route publication
never rewrites historical trip geometry.

## KPI definitions

| KPI | Numerator / value | Denominator / population | Zero/null rule |
| --- | --- | --- | --- |
| Trips | filtered trips | `[from,to)` planned departures | 0 |
| Confirmed bookings | `confirmedAt != null && cancelledAt == null` | filtered-trip bookings | 0 |
| Cancelled bookings | `cancelledAt != null` | filtered-trip bookings | 0 |
| Passengers | booking-passenger rows of active confirmed bookings | active confirmed bookings | 0 |
| Sold seats | unreleased booking-seat rows of active confirmed bookings | active confirmed bookings | 0 |
| Offered seats | historical trip seat-map cells with `kind=SEAT` | filtered trips | 0 |
| Load factor | sold seats | offered seats | `null` when capacity is 0 |
| Booking cancellation rate | cancelled bookings | all bookings in filtered trips | `null` when no booking |
| On-time departure | actual departure <= planned departure | trips with both timestamps | no sample => counts 0 |
| Delay | max(0, actual-planned), minutes | trips with both timestamps | no sample => average/max `null` |
| Resolution time | resolvedAt-openedAt, minutes | incidents with resolvedAt | no sample => `null` |
| Baggage anomaly rate | current non-null exception status | baggage belonging to filtered trips | `null` when no baggage |
| Fleet utilization | current ACTIVE vehicles used by filtered trips | current ACTIVE vehicles | `null` when none active |

The fleet utilization definition is intentionally operational and conservative:
it is **the share of the currently ACTIVE fleet that was assigned to at least
one trip in the selected planned-departure period**. It is not a kilometre- or
hour-based utilization metric because those facts are not yet authoritative in
the domain.

## Money and currencies

Amounts always remain integer minor units with an explicit `currencyCode` and
`currencyMinorUnit`. Buckets are keyed by both values. EUR, XOF, USD, or any
other currencies are never added together and PR-23 applies no exchange rate.

Per currency:

- ticket revenue = succeeded payment amounts;
- additional revenue = ACTIVE PR-22 trip revenues;
- gross revenue = ticket + additional revenue;
- refunds = recorded PR-22 refunds;
- net revenue = gross revenue - refunds;
- expenses = ACTIVE PR-22 trip expenses;
- contribution = net revenue - expenses;
- payouts = settlements of expenses (not a second expense);
- outstanding expense = expense - payout;
- contribution rate = contribution / net revenue (`null` when net revenue is 0).

Average money KPIs divide BigInt minor units by integer counts; the result stays
an integer minor-unit string. Display ratios are derived with bounded BigInt
fixed-point arithmetic rather than converting money to floating point first.

A profitable/loss/break-even trip count is computed **inside each currency
bucket**. A trip profitable in EUR and loss-making in XOF is represented in
both buckets; it is never collapsed into a synthetic cross-currency result.

## Incidents and baggage

Open incidents are statuses other than `RESOLVED` and `CLOSED`. Severity counts
are LOW/MEDIUM/HIGH/CRITICAL. Resolution-time samples require `resolvedAt`.

A baggage item is considered loaded when at least one `LOADED` baggage event
exists; delivered uses the current `DELIVERED` lifecycle state. An anomaly is
a current non-null baggage exception. Reporting exposes only counts, never a
passenger identity or baggage ownership details.

## Privacy

Reporting responses contain aggregate counts, public operational references,
route/vehicle labels and financial totals. They deliberately exclude customer
emails, phone numbers, passenger names, dates of birth, document numbers,
identity scans, payment-provider secrets and private receipts. The response
carries `privacy.containsPassengerPii=false` as an explicit contract assertion.

## Authorization

- `reporting.view` — overview and aggregated drill-down data;
- `reporting.export` — CSV/XLSX of the same aggregated dataset.

Default grants: SUPER_ADMIN, DIRECTOR, OPS_MANAGER and AUDITOR. FINANCE does not
receive Reporting automatically because the dashboard combines trip, fleet,
incident and baggage operational facts that its existing role intentionally
cannot read independently.

API authorization is authoritative. Hiding the OPS navigation entry is only a
usability measure.

## Exports

CSV and XLSX call the same ReportingService as the UI endpoint and therefore
share the exact period, RBAC and calculation rules. Exports contain aggregate
rows only and set private/no-store response caching.

## Limits

PR-23 is an operational dashboard, not statutory accounting, a general ledger,
a BI warehouse, or a forecasting engine. It does not introduce FX rates,
kilometre-based fleet utilization, inferred arrival/departure times, or
estimated data when an authoritative timestamp is absent.
