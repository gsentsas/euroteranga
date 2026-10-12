# Contributing to EURO TERANGA

## Workflow

The initial bootstrap commit is the only commit made directly on `main`.
From then on, `main` does not receive direct development.

```
branch
  ↓
implementation
  ↓
tests
  ↓
pull request
  ↓
CI
  ↓
review
  ↓
merge
```

- Every change starts from an up-to-date `main` on a dedicated branch.
- Every change reaches `main` through a pull request.
- A pull request is merged only when CI passes (once CI exists) and review
  conversations are resolved.
- Force-pushing to `main` and deleting `main` are not allowed.
- Keep pull requests focused: one scope per PR. Do not start work belonging to
  a later phase because it "would be convenient".

## Branch naming

| Prefix      | Use                                   |
| ----------- | ------------------------------------- |
| `feat/`     | New functionality                     |
| `fix/`      | Bug fix                               |
| `security/` | Security fix or hardening             |
| `chore/`    | Tooling, maintenance                  |
| `docs/`     | Documentation only                    |

Examples:

```
feat/pr01-foundation
feat/booking-seat-holds
fix/payment-idempotency
security/private-file-access
```

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) prefixes:

| Prefix      | Use                                             |
| ----------- | ----------------------------------------------- |
| `feat:`     | New functionality                               |
| `fix:`      | Bug fix                                         |
| `chore:`    | Tooling, dependencies, maintenance              |
| `docs:`     | Documentation                                   |
| `test:`     | Tests only                                      |
| `security:` | Security fix or hardening                       |
| `refactor:` | Code change without behaviour change            |

Example: `fix: reject duplicate payment webhook events`

## Pull requests

Fill in every section of the pull request template. Mark a section `N/A` when
it does not apply, rather than deleting it.

Pull requests touching authentication, authorization, payments, uploads,
personal data or permissions must include an explicit security review.
Pull requests containing database migrations must describe forward and
backward migration, locking risk and data risk.

Provide evidence, not claims: test counts, command output, CI links.

## Tests

- Never make CI green by deleting tests, skipping them without justification,
  weakening assertions, or mocking away the behaviour under test.
- Bug fixes include a test that fails before the fix and passes after.

## Secrets and personal data

Read [`SECURITY.md`](SECURITY.md) before contributing. This repository is
public: never commit secrets, real `.env` files, dumps or personal data.
Check your diff for secrets before every push.

## Dependencies

Before adding a significant dependency, document its purpose, license,
maintenance status, security history, alternatives and runtime/bundle impact.
EURO TERANGA is a commercial project: prefer permissive licenses (MIT,
Apache-2.0, BSD); strong copyleft licenses must be analysed before adoption.
