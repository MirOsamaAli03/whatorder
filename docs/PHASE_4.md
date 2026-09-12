# Phase 4 — Events, real-time, KDS, unacknowledged-order protection

Covers ENGINEERING_SPEC.md §33 (unacknowledged orders), §34 (kitchen display),
§35 (kitchen timers), §58 (outbox) and §64 (real-time). Complete and verified.
The kitchen screen that this phase deferred has since shipped — see
[DASHBOARD.md](./DASHBOARD.md).

## What exists

### The worker process

`apps/worker` is now a real process with two jobs:

- **`OutboxPublisher`** drains `outbox_events` in sequence order and publishes
  to Redis, then marks rows `PROCESSED`.
- **`EscalationMonitor`** finds orders that have gone unacknowledged, raises
  each rung of the ladder once, and resolves escalations when the order is
  finally accepted.

### Real-time delivery

Worker → Redis pub/sub → every API instance → connected clients over SSE.
Channels follow §64's shape, `tenant:{tenantId}:branch:{branchId}:orders`, and
the API always derives the channel from the session or a redeemed ticket, never
from the URL.

### API

```text
GET  /api/v1/kds/branches/:branchId/snapshot   orders.view
GET  /api/v1/kds/branches/:branchId/since      orders.view   ?sequence=
POST /api/v1/kds/branches/:branchId/ticket     orders.view
GET  /api/v1/kds/stream                        public, ticket-authenticated
GET  /api/v1/kds/unacknowledged                orders.view   ?branchId=
```

### Data

| Change | Why |
|---|---|
| `outbox_events.sequence` (BIGSERIAL, unique) | A monotonic watermark. A client that sees a jump knows it missed events and must resync. |
| `order_escalations` | Which rung fired, when, and whether it has been resolved. |
| `restaurant_worker` role | A third database role, narrower than the other two. |

## Decisions worth recording

**The escalation monitor polls the database; it does not schedule delayed
jobs.** A job scheduled in Redis and then lost — eviction, a flush, a restart
before persistence — fails *silently*, and the order it was guarding is never
escalated. For the one feature whose entire purpose is that nothing goes
unnoticed, silent loss is the unacceptable failure mode. Polling recovers by
itself: a worker that was down for ten minutes finds everything it missed on its
first pass and raises every rung that came due, rather than resuming as though
nothing happened. The cost is a query every few seconds against a partial index.

**A third database role, not `BYPASSRLS`.** Draining the outbox and finding
unacknowledged orders both need to look across tenants, which the application
role correctly cannot do. `BYPASSRLS` would have been the easy answer and is
role-wide — it would hand a background process unrestricted read of every table.
Instead `restaurant_worker` has policies on five tables and is refused menus,
customers, payments and audit logs *at the database*. It also cannot write an
order's status: escalation raises an alarm, it never touches the order. All of
that is asserted in the test suite against the real role.

**SSE, not WebSockets.** §64 permits either. A kitchen screen only ever
*receives* — actions go over ordinary HTTP — and SSE brings automatic browser
reconnection, passes through any proxy that speaks HTTP, and needs no additional
dependency. A WebSocket would have added a library and a second protocol for no
gain.

**Stream authentication uses one-time tickets.** `EventSource` cannot set an
Authorization header. Putting the access token in the query string writes a live
credential into every access log, proxy log and `Referer`; a cookie makes the
stream reachable from any page on the origin. Instead the client exchanges its
bearer token for a ticket that is single-use (redeemed with `GETDEL`, so two
racing connections cannot both use it), expires in 30 seconds, and is bound to
one user, tenant and branch. A leaked ticket opens one stream, for one branch,
once.

**The snapshot is the backbone, not the fallback.** A socket-only kitchen screen
is *worse* than a polling one, because a silently dead connection loses orders
invisibly. So the screen loads a snapshot carrying the current sequence, applies
live events each carrying their own, and reloads whenever it sees a gap, a
disconnect, or no heartbeat for two intervals. The live stream is an
optimisation over a correct baseline.

**Kitchen cards carry no money and no phone number** (§11). A cook needs the
dish, the options and the clock. A test asserts the payload contains neither.

**Card timers measure the current stage, not the order's age.** Someone looking
at the PREPARING column wants to know how long *this dish* has been on, not how
long ago the customer ordered.

**Tenant settings parse field by field.** A single typo — `taxPercent: "15"`
instead of `15` — used to discard the delivery fee, the minimum order and the
acknowledgement timeout along with it, silently putting a restaurant on defaults
it never chose. Each field now falls back independently.

## Two bugs worth recording

**Status-change events carried no `branchId`.** The publisher routes on it, so
every status change went to the tenant channel instead of the branch channel: a
kitchen screen showed new orders appear and then never move. The integration
tests missed it entirely because they inspected the outbox *rows* rather than
where those rows would be delivered — it only surfaced when a real SSE client
was attached. There is now a regression test asserting every order event carries
a `branchId`.

**The `organizations` RLS policy required privileges on `memberships`.** The
policy's login branch contains `EXISTS (SELECT 1 FROM memberships ...)`, and RLS
expressions are evaluated with the *caller's* privileges — so the worker needed
access to staff data merely to enumerate tenants. The wrong fix is a wider
grant; the membership lookup moved into a `SECURITY DEFINER` function
(migration `20260901000500`), which also removes the same hidden requirement
from the application role.

## Verification

**291 tests, all passing** (was 240 at the end of Phase 3).

| Suite | Count | Needs a database |
|---|---|---|
| `packages/domain` — money, authz, menu, state machine, pricing, **kitchen** | 127 | no |
| `packages/database` — enum parity, RLS coverage | 24 | no |
| `apps/api` — isolation, auth, rate limiting, menu, orders, **kds** | 140 | yes |

```bash
npm run build && npm run typecheck && npm run lint && npm test
```

All seven migrations apply to an empty database: 29 tables under RLS, 46
policies, four deliberate exceptions.

### The plan's two exit criteria

- *"kills the socket mid-order and proves the KDS recovers the order"* — a
  screen records its watermark, an order is placed and advanced while it is
  disconnected, and on reconnect `/since` returns the missed events and the
  snapshot contains the order.
- *"an unacknowledged order escalates on schedule"* — an order confirmed ten
  seconds ago against a 1/2/3-second ladder raises all three rungs, does not
  raise them twice, emits an event per rung through the outbox, and resolves
  once the order is accepted.

### Live verification

16 checks against a running API, a running worker, real Redis and a real SSE
client: a ticket issued and refused on reuse, the `connected` frame, an order
placed through checkout arriving over the stream within the poll interval, the
same for a status change, the sequence advancing past the watermark, and a fresh
order correctly *not* reported as unacknowledged.

## Known gaps

Tracked in [BACKLOG.md](./BACKLOG.md). The Phase 4 additions:

- ~~**The kitchen screen itself is not built.**~~ Shipped — see
  [DASHBOARD.md](./DASHBOARD.md), which also records three bugs in this phase's
  work that only a real browser client revealed.
- **Escalations are recorded but nobody is notified.** Each rung writes an
  `OrderAcknowledgementTimeout` event to the outbox, which is where Phase 5's
  notification worker picks it up. Until then the alarm is visible through
  `/kds/unacknowledged` but does not reach a phone.
- **No KDS heartbeat monitoring server-side.** The stream sends heartbeats and a
  client can detect staleness, but the API does not track which screens are
  connected, so §70's `KDS_DISCONNECTED` alert cannot fire yet.
- **Outbox rows are never pruned.** They accumulate as a permanent event log,
  which is useful but unbounded.
