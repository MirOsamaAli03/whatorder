# Phase 5 — Notifications and outbound WhatsApp

Covers ENGINEERING_SPEC.md §30 (notification events), §31 (channels), §32
(queue and backoff), §51 (opt-out), §68 (webhook replay protection), and plan
§2.2 and §2.4 — the WhatsApp Business realities the spec did not account for.
Complete and verified.

This is the phase where "no order goes unnoticed" stops being a screen and
starts being a message on somebody's phone.

## What exists

### The pipeline

```text
order committed ──> outbox_events ──> NotificationDispatcher ──> notifications
                                                                      │
                                                       NotificationSender
                                                                      │
                                         channel adapter ──> WhatsAppProvider
                                                                      │
                                              delivery callback ──> webhook
```

Four stages, deliberately separate. The dispatcher decides *who should be told
what*; the sender decides *how and when*; the adapter knows one channel; the
provider knows one BSP. Nothing upstream of the provider knows whether it is
working.

### Packages

| Package | Contents |
|---|---|
| `packages/domain/src/notifications.ts` | The rules, pure: the 24-hour window, `resolveWhatsAppSendMode`, jittered backoff, which status tells whom, and the message copy. 30 tests, no database. |
| `packages/whatsapp` | `WhatsAppProvider`, the provider registry, and `LogWhatsAppProvider` — the development sender, which can be taken down and brought back. |
| `packages/notifications` | The channel abstraction and its adapters, plus `NotificationDispatcher` and `NotificationSender`. |

### API

```text
GET   /api/v1/notifications                        customers.view
GET   /api/v1/notifications/preferences            organization.view
PUT   /api/v1/notifications/preferences            organization.manage
GET   /api/v1/notifications/whatsapp/accounts      organization.view
POST  /api/v1/notifications/whatsapp/accounts      organization.manage
PATCH /api/v1/notifications/whatsapp/accounts/:id  organization.manage
GET   /api/v1/notifications/whatsapp/templates     organization.view
POST  /api/v1/notifications/whatsapp/templates     organization.manage
PATCH /api/v1/notifications/whatsapp/templates/:id organization.manage
GET   /api/v1/customers/:id/consents               customers.view
POST  /api/v1/customers/:id/consents               customers.update
GET   /api/v1/webhooks/whatsapp                    public, verify-token handshake
POST  /api/v1/webhooks/whatsapp                    public, HMAC-verified
```

Permissions reuse the existing catalogue. Connecting a number is organization
configuration; the notification *history* sits behind `customers.view` instead,
because every row carries a destination — a phone number or an email address —
and kitchen staff deliberately do not hold that permission (§11).

### Data

Migrations `20260901000700` and `20260901000800`.

| Table | Why |
|---|---|
| `notifications` | One message owed to one person on one channel. Unique on `(event_id, recipient_type, recipient_id, channel)`, which is what makes the dispatcher safe to re-run. |
| `outbox_cursors` | A second consumer's watermark over the outbox. |
| `notification_preferences` | Which channels a tenant uses, per recipient type. |
| `whatsapp_accounts` | **Missing from the spec, on the critical path.** Maps an inbound `phone_number_id` to a tenant. |
| `whatsapp_templates` | Approval status per key per language, including Meta's rejection reason. |
| `whatsapp_messages` | Both directions. Inbound rows are what make the 24-hour window computable. |
| `customer_consents` | When and how consent was given, not a boolean. |
| `inbound_webhook_events` | Replay protection, generalised from `payment_events`. |

37 tables under RLS, 56 policies, the same four deliberate exceptions.

## Decisions worth recording

**A WhatsApp notification has two forms, and the choice is made at send time,
not at dispatch time.** Inside the 24-hour customer service window a free-form
session message is allowed, preferred, and free. Outside it, only an approved
template will do. Which applies depends on when the customer last messaged the
restaurant, so it cannot be decided when the notification is queued — a message
queued during an outage may be sent an hour later, on the other side of the
boundary. `resolveWhatsAppSendMode` is a pure function over four facts, and the
sender gathers those facts immediately before sending.

**Suppression is not failure, and it carries a reason.** A message the rules
forbid — a closed window with no approved template, marketing without opt-in —
is recorded `SUPPRESSED` with the reason in plain words. "Your `order_ready`
template is still PENDING approval" is something a restaurant can act on;
silence is not. This is the single most useful column in the support view.

**A suppressed message is promoted to the next channel rather than dropped.**
`order_ready` lists WhatsApp first and SMS after it. If WhatsApp cannot be used
at all, stopping there would mean the customer simply never hears — so the next
channel in the spec gets a row of its own. The unique constraint makes that safe
to repeat.

**An order update goes out once; an escalation goes out on every channel.** Not
a tuning knob, a difference in kind. Telling a customer their food is ready over
WhatsApp *and* SMS is noise they did not ask for and a bill the restaurant did
not need. But plan §2.8 is right that an alert on a screen nobody is looking at
is not an alert, and the dashboard being ignored is precisely the situation that
raised the escalation — so there, WhatsApp and SMS are not redundant, they are
the point. `NotificationSpec.deliveryMode` encodes the distinction.

**Not every status notifies.** CONFIRMED, ACCEPTED, READY, OUT_FOR_DELIVERY,
DELIVERED, COMPLETED, CANCELLED and REJECTED do. PREPARING and DRAFT do not: a
customer does not want to know their order moved from ACCEPTED to PREPARING,
that is kitchen detail, and over-messaging is how a business gets its WhatsApp
number blocked. Every notifying status is categorised UTILITY, never MARKETING,
and a test asserts it — a MARKETING categorisation would require opt-in and
could suppress an order update.

**Opt-IN for marketing, which is stricter than the spec.** §51 says "respect
opt-out preferences". Meta requires demonstrable opt-in, and the gap between the
two is an account-level risk rather than a nicety. `customer_consents` records
when and how, plus the evidence — the message the customer actually sent —
because the useful question later is "were we allowed to send that, at the time
we sent it", which a mutable boolean cannot answer. Order updates never consult
it: the customer asked for the food.

**The outbox got a second reader, and it needed its own cursor.** The realtime
publisher marks rows `PROCESSED`; a second consumer sharing that marker would
mean whichever arrived first hid the row from the other, and the symptom would
be *missing notifications*, which is silent. So the dispatcher keeps a watermark
in `outbox_cursors` and reads the outbox as an ordered log. The publisher keeps
using `status`, which suits it — an ephemeral fan-out where a duplicate is a
harmless re-render.

**The worker still cannot read a customer.** Phase 4 established that property
and tests it, and sending a message needs a phone number — so it would have been
easy to lose here. Instead the worker process holds *two* connections. The
worker role answers the cross-tenant question ("which tenant has work") and
nothing else; every step that touches a customer, a template, a consent record
or a message body runs on an ordinary tenant-scoped application connection under
the same RLS policy the API uses.

Finding due work still needs a cross-tenant read of `notifications`, and
granting the worker `SELECT` on that table would have handed a background
process every customer's phone number in `destination` and every message body in
`payload`. Postgres has the exact tool: a **column-level grant** of
`(tenant_id, status, next_attempt_at)`. `SELECT destination FROM notifications`
is refused to the worker at the database, by the same mechanism that refuses it
`menu_items`. A test asserts both halves.

**Routing an inbound webhook uses a `SECURITY DEFINER` function.** Meta's
webhook is per-app: every restaurant's callbacks arrive at one endpoint carrying
only a `phone_number_id`. Resolving that necessarily crosses tenants.
`app_whatsapp_account_route` is the narrowest possible hole — one opaque id in,
routing fields out, no message content, no customer, no credentials — and is the
same technique `app_user_belongs_to_org` uses for the login handshake. A `GRANT`
on `whatsapp_accounts` would have opened every column of every tenant's row.

**An unroutable webhook is recorded, not dropped.** A payload whose
`phone_number_id` matches no account is stored with a null tenant and an error,
admitted by a policy that only a connection with *no* tenant context can use. An
onboarding mistake that silently discards traffic is indistinguishable from a
quiet day, which is the failure this platform exists to prevent.

**Credentials are never returned by a read endpoint.** `hasCredentials: true` is
all any screen needs. A settings page that displays a provider access token is
one screenshot away from leaking it, and the audit row for connecting a number
deliberately omits them too — an audit log that records access tokens is a
credential store nobody meant to build.

**A template is created DRAFT, whatever the caller asks for.** Only the provider
can approve one. A template we marked approved ourselves would be attempted and
rejected at send time — once per retry.

**Retry is bounded, and classified.** Exponential from 30 seconds, doubling,
capped at an hour, with full jitter, giving up after six attempts. The jitter
matters more than it looks: an outage fails every queued notification at the
same instant, and without it they would all retry together and turn a recovery
into a second outage. Adapters classify their errors, because a rate limit
deserves the ladder and a malformed number does not — retrying that six times
only delays somebody noticing.

## A bug that only a running server revealed

**Meta's subscription handshake was returning the challenge wrapped in this
API's success envelope.** Meta compares the response body to the challenge it
sent, so `{"success":true,"data":"CHALLENGE123"}` is not a match and the webhook
**cannot be registered at all** — a failure at onboarding, long before any
message is involved. The integration suite did not catch it because asserting
`response.json().data` is exactly the shape the bug produces.

Fixed with an opt-in `@RawResponse()` decorator that the global response
interceptor honours; every other endpoint keeps the envelope §61.7 requires.
There is now a test asserting the raw body, and the signed webhook path is
verified against a real server, because `app.inject` in the harness does not use
the production `rawBody` setting that signature verification depends on.

## Verification

**375 tests, all passing** (291 at the end of Phase 4).

| Suite | Count | Needs a database |
|---|---|---|
| `packages/domain` — money, authz, menu, state machine, pricing, kitchen, **notifications** | 157 | no |
| `packages/database` — enum parity, RLS coverage | 32 | no |
| `packages/whatsapp` — provider, outage, registry | 6 | no |
| `packages/notifications` — channel adapters, error classification | 7 | no |
| `apps/api` — isolation, auth, rate limiting, menu, orders, kds, **notifications**, **pipeline** | 173 | yes |

```bash
npm run build && npm run typecheck && npm run lint && npm test
```

All nine migrations apply to an empty database.

### The plan's exit criterion

> *"order creation succeeds while the WhatsApp provider is hard-down (invariant
> 8), and the notification retries and eventually delivers when it recovers"*

`apps/api/test/notifications-pipeline.test.ts` runs the real dispatcher and
sender, against the real database, as the real worker and application roles,
with the development provider taken down by its own switch:

1. The provider is hard-down, and the order is placed anyway — `CONFIRMED`.
2. The notification is queued, not attempted, by the checkout path.
3. The first send fails and schedules a retry rather than giving up.
4. The order is untouched by any of it.
5. Nothing is attempted again before the retry is due — the backoff holds.
6. The provider returns, the retry comes due, and the message is `SENT`.

A companion test proves it gives up after six attempts rather than retrying
forever, and a third proves the worker role can schedule that work while being
refused `destination`, `payload` and `customers.phone` at the database.

### Live verification

Against a running API with a signing secret configured: a correctly signed
webhook accepted, a wrong signature refused, an unsigned request refused, the
handshake echoed bare with the right token and refused with the wrong one, and
the worker process booting all four jobs with both connections passing their
least-privilege guards.

## Known gaps

Tracked in [BACKLOG.md](./BACKLOG.md). New in this phase: no real SMS or email
provider (B-20), no notification settings screen in the dashboard (B-21), and
number migration from the WhatsApp Business app is unaddressed (B-22). B-16 —
escalations reaching a phone — is closed by this phase.
