# Restaurant OS

A multi-tenant platform for restaurants, chains, home kitchens and local food
vendors: WhatsApp ordering, online ordering, POS, kitchen display, payments,
tracking, notifications and reservations over **one** order core.

The governing principle, from [ENGINEERING_SPEC.md](./ENGINEERING_SPEC.md):

> WhatsApp, Web, QR, POS and future channels are interfaces over one
> centralized restaurant/order platform. No channel should contain independent
> business logic.

## Status

- **Phase 1 complete** — multi-tenancy, authentication, RBAC, dual-layer tenant
  isolation, audit trail. [docs/PHASE_1.md](./docs/PHASE_1.md)
- **Phase 2 complete** — menu, variants, modifiers, per-branch price and
  availability, and the transactional outbox.
  [docs/PHASE_2.md](./docs/PHASE_2.md)
- **Phase 3 complete** — customers, carts, the order state machine, COD
  checkout, idempotency and deterministic branch selection.
  [docs/PHASE_3.md](./docs/PHASE_3.md)
- **Phase 4 complete** — the outbox publisher, real-time SSE fan-out, the KDS
  snapshot and reconnect protocol, and unacknowledged-order escalation.
  [docs/PHASE_4.md](./docs/PHASE_4.md)
- **Phase 5 complete** — the notification pipeline, the 24-hour WhatsApp
  service window, per-tenant BSP routing, template approval tracking, consent,
  and delivery callbacks. [docs/PHASE_5.md](./docs/PHASE_5.md)
- **Phase 6 complete** — WhatsApp inbound ordering: the conversation state
  machine, a deterministic tap-driven flow in English and Roman Urdu, cart,
  COD checkout, order tracking and human handoff.
  [docs/PHASE_6.md](./docs/PHASE_6.md)
- **Dashboard shipped** — sign-in, live orders, menu management, the KDS, the
  WhatsApp conversations inbox and notification settings, with 26 browser tests
  against the real stack. [docs/DASHBOARD.md](./docs/DASHBOARD.md)
- **Pilot ready** — a restaurant can be onboarded and run without an engineer.
  [docs/WHATSAPP_ONBOARDING.md](./docs/WHATSAPP_ONBOARDING.md) covers connecting
  a number, including the migration objection.

453 unit and integration tests, plus 26 browser tests. Phase 7 onward (POS,
payments, analytics, reservations, AI) is not started.

Deferred and unfinished work is tracked in [docs/BACKLOG.md](./docs/BACKLOG.md).
The largest remaining gap is a real SMS provider: without one the last rung of
the escalation ladder logs instead of sending, so an ignored alert never reaches
a phone. After that, menu image upload, which needs a storage backend.

## Quick start

```bash
npm install
cp .env.example .env          # then set real JWT secrets
npm run db:deploy             # apply migrations
npm run db:seed               # demo chain + home kitchen
npm run dev
```

You need PostgreSQL 16 and Redis 7 first — see
[docs/LOCAL_SETUP.md](./docs/LOCAL_SETUP.md) (Docker) or
[docs/WSL_SETUP.md](./docs/WSL_SETUP.md) (Windows without Docker).

Seeded sign-ins, password `RestaurantOS123!`:

| Account | Role |
|---|---|
| `owner@kababjees.test` | Chain owner, four branches |
| `dha.cashier@kababjees.test` | Cashier, confined to the DHA branch |
| `ali@homekitchen.test` | Home kitchen owner, one branch |

## Layout

```text
apps/
  api/          NestJS + Fastify — HTTP surface, domain modules, the WhatsApp bot
  worker/       Outbox publisher, escalation monitor, notification dispatch
  dashboard/    Next.js — sign-in, live orders, menu, kitchen display
packages/
  types/        Enums, permissions, error codes, the auth context shape
  domain/       Framework-free logic: Money, authorization, notification rules
  database/     Prisma schema, migrations, RLS policies, seed
  whatsapp/     WhatsAppProvider interface, interactive messages, dev sender
  notifications/ Channel adapters, the dispatcher and the sender
infrastructure/
  docker/       docker-compose for Postgres and Redis
  wsl/          The same two services on WSL2, for Windows without Docker
docs/
```

`packages/domain` has no framework or database dependency. Pricing, the order
state machine and permission checks live there so that the WhatsApp adapter,
the POS, the web storefront and the AI tool layer all execute the *same* code —
which is what makes ENGINEERING_SPEC.md §87 structural rather than aspirational.

## Four things worth knowing before changing anything

**Tenant isolation is enforced twice.** Application code scopes every query
through `PrismaService.forTenant()`, and PostgreSQL Row-Level Security enforces
it again underneath. The API connects as a role that is not a superuser, owns
no tables and lacks `BYPASSRLS`, and it refuses to start otherwise. A query that
forgets its tenant filter returns nothing rather than everything.

**A channel is a principal, not an exception.** The WhatsApp bot calls the same
cart and order services the POS does, and it does so as a real member of the
organization: a membership holding `CHANNEL_BOT`, confined to one branch. So
branch checks, RLS and the audit trail all apply to it unchanged, and it holds
the narrowest grants in the system — notably not `orders.update`, because a
message from a customer must never move an order through the kitchen.

**Three database roles, not one.** The API connects as `restaurant_app` (RLS
enforced), migrations as `restaurant_owner`, and the background worker as
`restaurant_worker` — which can drain the outbox and read orders but is refused
menus, customers and audit logs at the database, and cannot change an order.

The worker process holds *two* connections for that reason. Sending a
notification needs a customer's phone number, so the worker role answers only
the cross-tenant question — which tenant has work — and every step that touches
a customer runs on an ordinary tenant-scoped application connection. Finding due
notifications uses a **column-level grant** of three scheduling columns:
`SELECT destination FROM notifications` is refused to the worker at the
database.

**Money never touches a float.** All arithmetic goes through the `Money` value
object in `packages/domain`, which holds integer paisa. Columns stay
`DECIMAL(12,2)`; JavaScript `number` is never an intermediate.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | All apps in watch mode |
| `npm run build` | Build every package |
| `npm run typecheck` | Type check without emitting |
| `npm run lint` | ESLint |
| `npm test` | Unit + integration tests |
| `npm run test:e2e` | Browser tests (needs the stack running) |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:deploy` | Apply existing migrations |
| `npm run db:seed` | Reference data + demo tenants |
| `npm run db:studio` | Prisma Studio |
| `npm run wsl:sync-env` | Point `.env` at WSL's current address |

## Contributing rules that are actually enforced

- Every tenant-owned table needs an RLS policy. `schema-guards.test.ts` fails
  the build otherwise.
- Prisma enums and `@restaurant-os/types` enums must match. Same test.
- Order status may only change through `transitionOrder()`. An ESLint rule
  rejects direct writes, with one deliberate one-line exemption inside that
  function.
- Every new Prisma enum goes in the parity list in `schema-guards.test.ts`.
- A feature is done when it meets ENGINEERING_SPEC.md §82, tests included.
