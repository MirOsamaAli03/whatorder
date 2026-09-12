# Dashboard and Kitchen Display

The first user-facing surfaces. Closes backlog items **B-1** (menu management
UI) and **B-15** (kitchen screen), which had been carried since Phase 2 and
Phase 4 respectively.

Until now a restaurant could not edit a menu, watch its orders or run a kitchen
screen without calling the API directly. It can now.

## What exists

`apps/dashboard` — Next.js App Router, four surfaces:

| Route | Purpose | Permission |
|---|---|---|
| `/login` | Sign in, including choosing between organizations | — |
| `/orders` | Live orders, status actions, the unacknowledged alarm | `orders.view` |
| `/kds` | Kitchen display: four columns, live stream, timers | `orders.view` |
| `/menu` | Menu management and the per-branch price/availability grid | `menu.view` |

Navigation adapts to the signed-in user's permissions (§44), and the branch
picker collapses to a label for a branch-scoped user who has only one (§7).

## The architectural rule this had to keep

**The dashboard holds no business logic.** ENGINEERING_SPEC.md §87 says channels
are thin adapters over one application layer, and a UI is the easiest place to
break that — it is always tempting to add up a total in the browser or decide
locally which button to show.

So, concretely:

- **It never computes money.** Every amount arrives as a fixed two-place decimal
  string and is rendered verbatim. `formatMoney` adds a currency label and
  thousands separators by string manipulation; it never parses to a float. There
  is no arithmetic on a price anywhere in the app.
- **It never decides which status transitions are legal.** The order list renders
  a button per entry in the API's `allowedTransitions`, which the server's state
  machine computed. Adding a status later changes no UI code.
- **It never resolves menu availability or branch pricing.** The API returns
  `price` and `availability` already resolved for the requested branch, alongside
  the chain-wide `basePrice` and `baseAvailability` for display.
- **Permission checks are for rendering only.** `session.can()` hides a button
  the user cannot use; the API enforces the same permission again and returns 403
  regardless. A tampered client gains nothing.

What the dashboard *does* reuse from `@restaurant-os/domain` is the pure
presentation helpers — `KDS_COLUMNS`, `urgencyFor` — so the column layout and
the colour bands come from the same source as the server rather than a second
copy that drifts.

## Decisions worth recording

**The access token lives in memory; the refresh token stays in its httpOnly
cookie.** Nothing is written to `localStorage`, where injected script could read
it. The cost is that a page reload starts with no token and silently exchanges
the cookie for a new one, which is why the session has a `loading` state rather
than assuming anonymous. A browser test asserts the reload path works.

**The kitchen screen treats the snapshot as truth and the stream as an
optimisation.** It loads a snapshot carrying the server's sequence, applies live
events carrying their own, and reloads on a gap, a disconnect, or two missed
heartbeats — plus a slow reconciliation poll regardless. A socket-only screen is
*worse* than a polling one, because a silently dead connection loses orders
invisibly.

**Sound is armed by an explicit button.** Browsers block audio before a user
gesture, so a screen that simply calls `play()` on a new order has no audible
alert *and never says so* — the worst outcome for a feature whose job is that
nothing goes unnoticed. The tone is synthesised with WebAudio, so there is no
asset to ship and no request that can fail.

**Plain CSS, no utility framework.** Six screens do not justify another build
step and another dependency to track (Rule 3). The kitchen display in particular
needs deliberate large-format, high-contrast styling that reads across a room,
which is clearer written directly.

**Prices are typed into a `type="text"` input, not `type="number"`.** A number
input hands back a float, and `700.10` does not survive that round trip. The
field sends a string; the API validates its shape and parses it into integer
paisa.

## Three bugs the browser tests caught

None of these were visible to 291 passing server-side tests.

**1. The SSE stream had no CORS headers.** The handler writes to `reply.raw`,
which bypasses Fastify's reply pipeline entirely — so the
`Access-Control-Allow-Origin` header `app.enableCors()` would have added never
reached the response. The stream worked perfectly same-origin and failed in
every browser that was not, which is every real deployment. Now set explicitly,
echoing the origin only when it is on the configured allowlist.

**2. Helmet was sending `Cross-Origin-Resource-Policy: same-origin`.** A sensible
default for a site that serves its own pages; wrong for an API whose entire
purpose is to be read from another origin. Now `cross-origin`, with who may
actually call the API still decided by the CORS allowlist.

**3. CORS listed `http://localhost:3000` but not `http://127.0.0.1:3000`.** To a
browser those are different origins, and the request from the missing one fails
with a message that looks like the API is down rather than like a configuration
problem. Both loopback spellings are now in `.env.example`.

A fourth finding was not a bug but a real product concern: **the login rate
limit was 10/min per IP**, and every member of staff in a restaurant shares one
NAT-ed address, so a shift change could lock out the floor. Raised to 60, with
the reasoning recorded in `.env.example`: brute force against a specific account
is already handled more precisely by the per-account lockout (10 failed
attempts, 15 minutes), so the IP limit only needs to stop volumetric abuse.

## Verification

**20 browser tests**, run against the real stack — API, worker, Redis, Postgres
and a real Chromium:

```bash
npm run dev            # or start api, worker and dashboard separately
npm run test:e2e
```

They cover sign-in and the wrong-password path, session survival across a
reload, permission-driven navigation, the seeded menu with branch-resolved
prices, marking an item sold out at one branch and proving another is
unaffected, rejecting a malformed price, advancing an order from the order list
and from the kitchen screen, the four KDS columns, the live connection
indicator, the sound control, a ticking timer, and a branch-scoped user seeing
only their own branch.

The one that matters most: **an order placed through the API appears on an open
kitchen screen with no reload** — the outbox publisher, Redis and SSE end to
end.

A `browser` job in CI runs them on every push, uploading Playwright traces on
failure.

## Known gaps

- **Image upload (B-2) is still open.** `imageUrl` is stored and returned, and
  the editor does not offer an upload because there is no storage backend yet.
  This is the one piece of the original UI backlog still outstanding.
- **No category management screen.** Categories can be created through the API
  and items assigned to them, but the UI cannot rename or reorder them.
- **No modifier editor.** Modifier groups are shown on an item and enforced at
  order time; creating and editing them is still API-only.
- **No variant editor.** Same.
- **The order list polls every ten seconds** rather than subscribing. The KDS is
  the screen that needs immediacy; this is the calmer management view and does
  not warrant a second long-lived connection per tab.
- **No customers, reservations, POS or analytics screens.** Those belong to
  their own phases.
