# EURO TERANGA

> **Status: Initial architecture / pre-development**
>
> No feature described below is available yet. This repository currently contains
> governance and architecture documents only. Implementation starts with
> **PR-01 Foundation**.

EURO TERANGA is a future digital platform for operating international road
passenger transport services between Europe and Africa.

- **Website:** <https://euroteranga.com>
- **First product:** EURO TERANGA COACH
- **First corridor:** Paris ↔ Dakar
  - France → Spain → Morocco → Mauritania → Senegal

## Planned architecture

```
Web / Booking / Client / Tracking
            ↓
          Core API
            ↓
        PostgreSQL
            ↓
 OPS / Crew / Workers / Storage
```

The Core API is the single source of business authority: frontends never access
the database directly. The backend is planned as a modular monolith.

See [`docs/architecture/README.md`](docs/architecture/README.md) for the target
architectural decisions.

## Planned applications

| Application | Planned domain              | Purpose                               |
| ----------- | --------------------------- | ------------------------------------- |
| Web         | `euroteranga.com`           | Public website                        |
| Booking     | `booking.euroteranga.com`   | Search and booking                    |
| Client      | `client.euroteranga.com`    | Customer portal                       |
| Tracking    | `tracking.euroteranga.com`  | Trip tracking                         |
| Ops         | `ops.euroteranga.com`       | Back-office for operations            |
| Crew        | `crew.euroteranga.com`      | Offline-first crew application        |
| API         | `api.euroteranga.com`       | Core API                              |

None of these applications exist yet.

## Local setup, commands and tests

Not available yet. Toolchain versions (Node.js, package manager, frameworks,
database) are deliberately not fixed here: they will be selected and pinned in
PR-01 Foundation after verifying current stable releases and compatibility with
the target environment.

## Environment variables

All configuration will be provided through environment variables, validated at
startup. Only a `.env.example` file with placeholder values will ever be
committed. Real `.env` files must never be committed.

## Contributing

`main` does not accept direct development. All changes go through a branch and a
pull request. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

This repository is **public**. Never commit secrets, credentials, database dumps
or personal data. To report a vulnerability, follow
[`SECURITY.md`](SECURITY.md) — do not open a public issue with exploitable
details.

## License

Proprietary. All rights reserved. See [`LICENSE`](LICENSE).
