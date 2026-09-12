# Phase 3 — Customers, cart, orders, COD checkout

Covers Sprint 3 of ENGINEERING_SPEC.md §83, plus §17 idempotency, §28 checkout,
§29 branch selection and the state-machine corrections from the plan's §2.5.
Complete and verified.

## What exists

### Data

Twelve new tables, all tenant-owned and all under RLS:

| Table | Notes |
|---|---|
| `customers`, `customer_addresses` | Phone is the identity key, stored E.164 |
| `delivery_zones` | **Missing from spec v1** — §29 requires a delivery radius and per-area fees with nothing to store them |
| `carts`, `cart_items`, `cart_item_modifiers` | **Named but never defined** in §27 |
| `orders` | §12, plus `business_date`, stage timestamps and an orthogonal `payment_status` |
| `order_items`, `order_item_modifiers` | Snapshots (§13, §14) |
| `order_status_history` | **Missing from spec v1** — who moved an order, from what, and why |
| `order_number_counters` | Human-readable numbers, unique per branch per business day |
| `idempotency_keys` | §17 mandates idempotency and defines no storage |

### Domain logic

- **`order-state-machine.ts`** — the transition rules as *data*, not branching
  code, plus `statusAfterCheckout`, `completionStatusFor`, `nextStatuses` and
  `customerMayCancel`.
- **`pricing.ts`** — `computeOrderTotals`, `computeBusinessDate`, `haversineMetres`.

### API

```text
GET    /api/v1/customers                      customers.view
GET    /api/v1/customers/:id                  customers.view
GET    /api/v1/customers/:id/orders           customers.view
POST   /api/v1/customers                      customers.update
PATCH  /api/v1/customers/:id                  customers.update
POST   /api/v1/customers/:id/addresses        customers.update
PATCH  /api/v1/customers/addresses/:id        customers.update
DELETE /api/v1/customers/addresses/:id        customers.update

GET    /api/v1/branches/eligible              branches.view    (§29)

POST   /api/v1/carts                          orders.create
GET    /api/v1/carts/:id                      orders.view
PATCH  /api/v1/carts/:id                      orders.create
POST   /api/v1/carts/:id/items                orders.create
PATCH  /api/v1/carts/:id/items/:itemId        orders.create
DELETE /api/v1/carts/:id/items/:itemId        orders.create
DELETE /api/v1/carts/:id/items                orders.create

GET    /api/v1/orders                         orders.view
GET    /api/v1/orders/:id                     orders.view
POST   /api/v1/orders                         orders.create    (Idempotency-Key required)
POST   /api/v1/orders/:id/transition          orders.update
POST   /api/v1/orders/:id/cancel              orders.update
```

## Decisions worth recording

**Fulfilment state and money state are separate columns.** Spec §15 lists
`REFUNDED` and `PAYMENT_FAILED` alongside `PREPARING` and `READY`, which makes a
refunded-but-still-cooking order unrepresentable. `status` now only ever says
where the food is; `payment_status` only ever says where the money is. The
payoff shows up immediately: a failed online payment leaves the order in
`PENDING_PAYMENT` with `payment_status = FAILED`, so the customer can retry
without the order having gone anywhere.

**Cash orders never enter `PENDING_PAYMENT`.** Spec v1 routes every order
through payment, which would strand every cash order in Pakistan in a state it
can never leave. `statusAfterCheckout` sends cash and card-on-delivery straight
to `CONFIRMED`, and reaching the customer is what settles them —
`DELIVERED`/`COMPLETED` flips a COD order to `PAID`, because that is when the
money changes hands.

**The transition rules are data.** `ORDER_TRANSITIONS` is a map, so the test
suite checks every from/to pair across all three order types — 507 combinations
— rather than the handful someone thought to write down. `DELIVERED →
PREPARING` fails because it is absent from the map, not because a specific check
rejects it. The suite also proves every status is reachable from `DRAFT` and
that no non-terminal status is a dead end.

**Two states beyond spec v1.** `DELIVERY_FAILED` and `RETURNED`: real deliveries
fail, and v1 offers only `DELIVERED` or `CANCELLED` as exits. A failed delivery
can be re-dispatched or returned, but deliberately *not* cancelled — the food
was made and the loss is real; cancelling would erase it from the day's numbers.

**Carts store intent, never money.** No total is persisted on a cart. Every
figure is recomputed from current menu prices on each read, by the same
`CartPricingService` that checkout uses — so what the customer was shown and
what they are charged cannot drift, and there is no stored total to go stale.
The snapshot is taken exactly once, at checkout.

**A cart preview reports blockers; checkout refuses.** Adding a sold-out item
fails immediately, but an item that sells out *while* a cart is open shows up in
`blockers` with `canCheckout: false` rather than as an error page — the customer
can see what to remove. At checkout the same code runs in strict mode and
throws.

**`Idempotency-Key` is mandatory on order creation, not optional.** A retry over
a dropped mobile connection is the normal case, not an edge one. The key is
claimed with a unique INSERT so two simultaneous retries race at the database
and exactly one wins; the loser replays the first response. A key reused with a
*different* body is rejected outright, and a key is released when its request
fails so a transient error does not lock it for 24 hours.

**Order numbers are allocated from a per-branch, per-day counter row** updated
inside the order's transaction, which takes a row lock. A sequence would be
simpler but would leave gaps and leak platform-wide volume to anyone counting.

**Phone numbers are the customer identity, normalised to E.164.** "0300 1234567",
"+92 300 1234567" and "3001234567" are one person; without normalisation each
channel creates its own record and the CRM quietly becomes useless.

**Branch selection is deterministic.** Active branch → delivery enabled → a zone
covers the address → nearest wins. Overlapping zones resolve by `sortOrder`, so
a cheap inner zone beats the wider one it sits inside. Capacity and live
preparation time are explicitly later work: a scoring model now would produce a
system nobody can explain to an owner asking why an order went to the wrong
branch.

**Deleting a branch with orders is refused at the database** (`ON DELETE
RESTRICT`). Losing a branch would take its financial history with it.

## Verification

**240 tests, all passing** (was 145 at the end of Phase 2).

| Suite | Count | Needs a database |
|---|---|---|
| `packages/domain` — money, authorization, menu, **state machine, pricing** | 105 | no |
| `packages/database` — enum parity, RLS coverage | 23 | no |
| `apps/api` — isolation, auth, rate limiting, menu, **orders** | 112 | yes |

```bash
npm run build && npm run typecheck && npm run lint && npm test
```

All four migrations apply cleanly to an empty database: 28 tables under RLS with
36 policies, and four deliberate exceptions (`users`, `sessions`, `permissions`,
`_prisma_migrations`).

The ESLint rule forbidding direct `order.status` writes has exactly one
exemption, one line wide, inside `transitionOrder`. That exemption was verified
not to weaken the rule by linting a probe file containing a direct write, which
was correctly rejected.

### Live verification

35 checks against a running server and the seeded demo data, walking one real
delivery order: a required modifier, a variant whose price replaces the base, an
address 2km from the DHA branch landing in the cheap inner zone rather than the
wider one, cash confirmed without a payment step, a retried checkout returning
the same order, a delivery that fails and is re-dispatched, cash settling on
handover, `DELIVERED → PREPARING` refused, and the order's total unchanged after
the menu price was edited.

## Known gaps

Tracked in [BACKLOG.md](./BACKLOG.md). The Phase 3 additions:

- **Delivery zone CRUD.** Zones drive branch selection and fees, and can
  currently only be created by the seed or by SQL. Deferred as admin
  configuration, alongside the Phase 2 menu-management UI (B-1).
- **Discounts are plumbed but never computed.** `computeOrderTotals` accepts a
  discount and the order stores one; nothing produces a non-zero value until
  promotions land.
- **No cart or idempotency-key sweeper.** Both carry `expires_at` and both are
  indexed on it; nothing prunes them yet. Needs the Phase 4 worker.
- **No customer order-tracking endpoint** (§43). Planned for Phase 10.
- **Blocked customers are refused at checkout but nothing blocks them earlier**,
  so they can still build a cart.
