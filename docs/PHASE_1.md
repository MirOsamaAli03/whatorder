# Phase 1 — Foundation, identity and tenant isolation

Covers Sprint 1 of ENGINEERING_SPEC.md §83 plus the Phase 0 infrastructure it
needs. Everything here is implemented, tested and verified against a real
database.

## What exists

### Infrastructure

- npm workspaces + Turborepo monorepo, five packages.
- PostgreSQL 16 and Redis 7, via `docker-compose` or the WSL2 equivalent.
- Environment validated by a Zod schema at boot; the process exits with a
  readable list of problems rather than failing later on an undefined value.
- Structured JSON logs with a request id on every line, credentials redacted at
  the logger.
- The §62 error envelope as a global exception filter; stack traces, database
  errors and provider details never reach a client.
- `/health` (liveness, touches nothing) and `/ready` (checks Postgres and Redis,
  503 when either is down).
- GitHub Actions CI: install → create the app role → migrate from empty → build
  → typecheck → lint → test.

### Domain

- `Money`, exact to the paisa (see below).
- The permission catalogue, the eight system roles and their grants, branch
  scoping — all pure functions, no framework, no database.

### Data

Eleven tables. Beyond ENGINEERING_SPEC.md §9, four exist because the spec's own
prose requires them (see the plan's §2.4):

| Table | Why it is not in spec v1 |
|---|---|
| `memberships` | `users.tenant_id` makes it impossible for one person to work for two organizations, and forces a globally unique email into a tenant-scoped row. |
| `membership_branches` | §7 checks `order.branch_id IN authorizedBranches`; nothing stored that set. |
| `membership_roles`, `role_permissions`, `permissions` | §9 lists roles and permission strings but defines no tables assigning them. |
| `sessions` | §5 requires refresh handling. |

Also added ahead of later phases: `organizations.default_language` (Roman Urdu
is unavoidable in this market) and `organizations.business_day_start_minutes`
(a kitchen serving past midnight must report those orders against the previous
business day, or every daily revenue figure is wrong).

### API

```text
POST   /api/v1/auth/login          Public, rate limited
POST   /api/v1/auth/refresh        Public, rate limited, rotates
POST   /api/v1/auth/logout
GET    /api/v1/auth/me

GET    /api/v1/organizations/current       organization.view
PATCH  /api/v1/organizations/current       organization.manage

GET    /api/v1/branches                    branches.view
GET    /api/v1/branches/:id                branches.view
POST   /api/v1/branches                    branches.manage
PATCH  /api/v1/branches/:id                branches.manage

GET    /api/v1/staff                       staff.view
GET    /api/v1/staff/roles                 staff.view
GET    /api/v1/staff/:id                   staff.view
POST   /api/v1/staff                       staff.manage
PATCH  /api/v1/staff/:id                   staff.manage

GET    /health   GET /ready                Public
```

`/organizations/:id` from §60 is deliberately `/organizations/current`. A caller
has exactly one organization in scope, taken from their session; accepting an id
would create a parameter that must be checked on every request and can be
forgotten once.

## Decisions worth recording

**Tenant isolation is enforced twice, independently.** §7 asks for reusable
scoping utilities and warns against relying on developers remembering a filter.
Application code goes through `PrismaService.forTenant()`, which opens a
transaction and sets `app.tenant_id`; PostgreSQL RLS policies then filter every
row. The API connects as `restaurant_app` — not a superuser, owns no tables, no
`BYPASSRLS` — and `assertLeastPrivilegeConnection` refuses to boot otherwise,
because a `DATABASE_URL` pointed at the owner role would silently disable every
policy with no error anywhere.

**Login needed a hole, and did not get one.** Listing the organizations a user
may sign in to requires reading their memberships before any organization is
chosen. Rather than exempting the table, the `memberships` and `organizations`
policies also admit rows reachable from `app.user_id`, which is set only after
the password has been verified.

**Audit rows are written inside the transaction they describe**, through
`AuditService.recordIn(tx, …)`. The plan proposed an interceptor; explicit
in-transaction calls turned out better on both counts that matter — a change
cannot commit while its audit row rolls back, and the old/new values are the
actual ones rather than a reconstruction from the request body. `audit_logs` is
append-only at the database: it has SELECT and INSERT policies and no others, and
under RLS an operation without a policy is denied, so application code cannot
rewrite history.

**Refresh tokens rotate, and reuse is treated as theft.** Each refresh issues a
new session and revokes the old one. Presenting an already-rotated token revokes
every session in that chain rather than merely failing, because a replayed token
means the credential is loose.

**Roles cannot be used to escalate.** A member may only grant roles whose
permissions they already hold, and nobody may edit their own roles or
membership status. Without the first rule, any account with `staff.manage` could
mint itself an owner.

**Money is integer paisa.** `0.1 + 0.2 !== 0.3`, and a float rounding error in
tax or discount corrupts revenue reporting silently, a fraction of a paisa at a
time. Columns remain `DECIMAL(12,2)`; `Money` is what arithmetic passes through.

## Deviations from the approved plan

| Planned | Actual | Why |
|---|---|---|
| pnpm | npm workspaces | pnpm links workspace packages with real symlinks, which Windows refuses without Developer Mode or an elevated shell. npm uses directory junctions, which need no elevation. |
| Docker for Postgres/Redis | WSL2 Ubuntu | Docker is not installed on this machine. `docker-compose.yml` is committed and CI uses service containers, so the portable path is intact. |
| Supertest | Fastify `app.inject()` | Covers the same surface without binding a socket; Supertest was removed rather than left unused. |
| Audit interceptor | Explicit in-transaction writes | Atomicity and accurate before/after values, as above. |

One machine-level change was made outside the repository:
`%USERPROFILE%\.wslconfig` now sets `networkingMode=mirrored`, because Windows
was dropping packets to the WSL network adapter and nothing in WSL was reachable
on `localhost`. Delete that file and run `wsl --shutdown` to revert.

## Verification

88 tests, all passing.

| Suite | Count | Needs a database |
|---|---|---|
| `packages/domain` — Money, authorization | 34 | no |
| `packages/database` — enum parity, RLS coverage | 12 | no |
| `apps/api` — tenant isolation | 22 | yes |
| `apps/api` — authentication | 14 | yes |
| `apps/api` — rate limiting, health | 6 | yes |

```bash
npm run build && npm run typecheck && npm run lint && npm test
```

### The isolation suite proves it twice

Once through the API, and once directly against the database as the application
role with the tenant context set by hand and **no** `WHERE` clause — which is
exactly what a forgotten filter looks like. That second half is the point: the
first half would keep passing for existing endpoints while a newly added,
unfiltered query leaked. The database-level tests assert that an unfiltered
`findMany` returns only the current tenant's rows, that a foreign row cannot be
read by id, updated or deleted, that inserting a row for another tenant is
rejected, that absent tenant context returns nothing at all, and that
`audit_logs` cannot be rewritten.

The suite also asserts that the connection it is testing through is not a
superuser, owns no tables and lacks `BYPASSRLS` — otherwise every other
assertion in that block would pass vacuously.

### Migrations from empty

Verified by applying both migrations to a freshly created database and
confirming RLS is enabled on all eight tenant-owned tables, disabled on the
three deliberate exceptions (`users`, `sessions`, `permissions`), and that
`audit_logs` carries only SELECT and INSERT policies.

## Known gaps

- No web UI. The dashboard, POS, KDS and customer site arrive with Phase 2.
- `apps/worker` is a stub; queues arrive with Phase 4.
- No password reset or invitation email. Invited users get an unusable random
  password and currently need an administrator to set one.
- No 2FA enforcement. The columns exist; §66 wants it for privileged accounts.
- Permissions are re-read from the database on every request. Correct, and
  revocation is immediate, but it is two queries per call — cache it when
  analytics gives us real latency numbers, not before.
- No platform back office, though `PLATFORM_ADMIN` and `isPlatformAdmin` exist.
