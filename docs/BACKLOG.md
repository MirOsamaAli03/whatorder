# Backlog — deferred and unfinished work

Work that was in scope for a phase but not delivered in it, plus decisions
consciously postponed. Kept in the repository rather than in a conversation so
nothing is quietly dropped.

Each item says which phase it belonged to, why it was deferred, and what would
have to be true to close it.

---

## Open — carried from Phase 2 (menu)

### B-2. Menu image upload

**Phase:** 2 · **Status:** not started · **Depends on:** B-1

`menu_categories.image_url` and `menu_items.image_url` accept a URL, and the API
stores and returns it. There is no upload path: no S3-compatible bucket wiring,
no presigned-URL endpoint, no validation of type or size, no thumbnailing.

Deferred deliberately alongside B-1. A presigned-upload flow is shaped by the
screen that uses it — direct-to-bucket versus proxied, where cropping happens,
what a failed upload leaves behind — and designing it without that screen tends
to produce an endpoint the UI then has to work around.

**Needs:** a `StorageProvider` abstraction (mirroring `PaymentProvider` and
`WhatsAppProvider`), an S3-compatible implementation, a presigned-upload
endpoint with content-type and size limits, and cleanup of orphaned objects.

---

## Open — carried from the dashboard

### B-19. Category, modifier and variant editors

**Phase:** dashboard · **Status:** not started

The menu screen can create and edit items, toggle availability per branch and
set a branch price. Categories, modifier groups and variants are still API-only:
they can be read and are enforced correctly at order time, but there is no
screen to rename a category, reorder one, or build a new modifier group.

Lower priority than B-1 was, because the daily operations — price, sold out —
are covered, and menu structure changes rarely.

---

## Open — new in Phase 6 (WhatsApp ordering)

### B-25. A multi-branch tenant on one number picks the first branch

**Phase:** 6 · **Status:** narrow, but wrong when it happens

`whatsapp_accounts.branch_id` carries the outlet, and a chain is expected to run
a number per branch — which is what Kababjees-class targets do. A home kitchen
has one branch, so there is nothing to choose. The gap is a multi-branch tenant
on a single tenant-wide number: the conversation picks the oldest active branch,
which will be the wrong one for most of their customers.

**Needs:** a branch-selection step before the menu — either a list of branches,
or, better, asking for the delivery address first and using the existing §29
zone resolution to choose the branch, which is the answer the rest of the system
already has.

### B-26. Modifiers and variants cannot be chosen in the conversation

**Phase:** 6 · **Status:** deliberate scope limit

The cart and order services fully support variants and modifier groups, and the
POS and dashboard expose them. The WhatsApp flow adds an item at its base price
with no options, because asking "which size?" and "any extras?" over reply
buttons is several more states and the deterministic flow was worth landing
first.

A restaurant whose menu is mostly single-price dishes — most home kitchens — is
unaffected. One selling pizzas by size is not really usable over WhatsApp yet.

**Needs:** a modifier sub-flow: required groups asked in order as button or list
prompts, optional ones offered once, then the existing addItem call with the
chosen optionIds — which already validates that each belongs to the item.

### B-27. Free text outside the keyword list is not understood

**Phase:** 6 · **Status:** by design, closed by Phase 11

"2 chicken burger aur ek coke" returns UNKNOWN and the bot offers its buttons
again. That is the deliberate Phase 6 position (plan §2.2: prove the channel
works with no LLM in the path), and the menu search covers a typed dish name,
but it is the gap Phase 11's AI layer exists to close.

---

## Open — new in Phase 5 (notifications)

### B-20. No real SMS or email provider

**Phase:** 5 · **Status:** abstraction done, provider missing

`LogChannelAdapter` stands in for SMS and email: both channels are registered,
both are chosen and recorded correctly, and both log instead of sending. The
escalation ladder therefore *believes* it has reached a manager's phone when it
has not.

This is the one gap in this phase with operational consequences, because plan
§2.8's off-channel fallback is the last rung of "no order goes unnoticed".
Everything above the adapter is finished, so closing it is one class plus
credentials.

**Needs:** a Pakistani SMS gateway account (Telenor, Jazz or an aggregator), an
adapter implementing `NotificationChannelAdapter`, and its credentials per
tenant — following `whatsapp_accounts`, since an SMS sender id is per business
too. Email needs the same shape plus a template renderer.

### B-21. No notification settings screen

**Phase:** 5 · **Status:** API complete, UI absent

Preferences, WhatsApp numbers, templates and their approval status are all
readable and writable through the API, and the approval status is the thing a
restaurant most needs to see — a `REJECTED` template is why their customers
stopped hearing from them. There is no screen for any of it, so connecting a
number is an engineer's job.

Same call as B-1 and B-19: the settings screens are grouped and will land
together.

### B-22. Number migration is unaddressed (plan §2.2)

**Phase:** 5 · **Status:** known onboarding blocker

A Kababjees-class target already uses its WhatsApp number in the WhatsApp
Business *app*, and a number cannot be in both the app and the API at once.
Onboarding has to include a guided migration, and the restaurant loses its
existing chat history and app workflow. The plan predicted this would be the
single biggest onboarding objection and it is unaddressed: there is no guidance,
no checklist and no support doc.

**Needs:** an onboarding flow with the migration steps, a support document, and
a dashboard state for "number not yet migrated" so it is visible rather than
presenting as silence.

### B-23. Retry classification is coarse for real providers

**Phase:** 5 · **Status:** correct but untested against a real BSP

`WhatsAppSendError.retryable` is the right shape, and the log provider
classifies its own failures. A real BSP returns dozens of error codes, and
misclassifying a permanent one as retryable wastes six attempts while
misclassifying a transient one loses a message. The mapping can only be written
against a real provider's documentation.

---

## Closed in the pilot-readiness pass

### B-24. Inbox for handed-off conversations — **closed**

**Phase:** 6 · **Closed by:** the pilot-readiness pass

A conversations screen lists everyone waiting, longest first, with the waiting
time as the loudest thing on the row and a count badge in the navigation so
nobody has to keep the tab open. Staff can read the thread, reply over the same
number the bot uses, and hand the conversation back to the bot. The reply box
respects WhatsApp's 24-hour window and says why when it cannot be used, rather
than letting somebody type a paragraph and have it refused.

Six browser tests cover it against the real stack. One follow-up remains, split
out as B-28: nothing yet reaches a phone when a handoff goes unanswered.

### B-21. Notification settings screen — **closed**

**Phase:** 5 · **Closed by:** the pilot-readiness pass

Settings now covers connecting a WhatsApp number, activating and deactivating
one, the notification-channel grid, and the template list with approval status.
A rejected or paused template is called out at the top of the page with Meta's
own reason next to the template, because it is the likeliest reason a
restaurant's customers quietly stop hearing from them and it fails silently
everywhere else. Credentials are write-only and never rendered.

### B-22. Number migration guidance — **closed**

**Phase:** 5 · **Closed by:** the pilot-readiness pass

[WHATSAPP_ONBOARDING.md](./WHATSAPP_ONBOARDING.md) covers the objection in full
— a number cannot be in the WhatsApp Business app and the API at once, the chat
history does not transfer, and the two honest options — plus what Meta requires,
the 24-hour window and why templates are the long pole, how to connect a number,
what to check when nothing arrives, the limitations that stand at pilot, and a
go-live checklist.

### B-29. The production images are unbuilt

**Phase:** deployment · **Status:** written, never run

`infrastructure/docker/Dockerfile.node`, `Dockerfile.dashboard` and
`docker-compose.prod.yml` were written on a machine without Docker. They are
reviewed and structurally checked — every `depends_on` resolves, every variable
is documented, and the Next standalone server was run directly to prove that
half of the dashboard image — but **no image has been built**.

Expect to fix something on the first `docker compose build`.
[DEPLOYMENT.md](./DEPLOYMENT.md) lists the likely causes in order.

**Needs:** one build on a machine with Docker, then a deployment to a real host.

### B-30. No automated backups

**Phase:** deployment · **Status:** documented, not automated

The database is the only thing that cannot be rebuilt from the repository.
DEPLOYMENT.md gives the `pg_dump` line; nothing runs it, and nothing copies it
off the machine. This is the gap that would hurt most on the day it matters.

### B-28. An unanswered handoff does not reach a phone

**Phase:** 6 · **Status:** new, split from B-24

The inbox makes a waiting customer visible to anyone looking at the dashboard,
and the navigation badge makes it visible from any screen. It still depends on
somebody having the dashboard open. An unacknowledged *order* escalates through
a ladder; an unanswered *customer* does not.

**Needs:** the escalation monitor to sweep conversations in HUMAN_HANDOFF past a
threshold and raise a staff notification the same way it raises one for an
order — which also needs B-20, since the last rung is SMS.

---

## Closed in Phase 5

### B-16. Notifications for escalations — **closed**

**Phase:** 4 · **Closed by:** Phase 5

Every escalation rung writes an `OrderAcknowledgementTimeout` event to the
outbox, and the notification dispatcher now picks it up and fans it out to every
enabled staff channel at once — dashboard, WhatsApp and SMS together, because
§33's point is that it escalates *off-screen* once the screen has been ignored.

Genuinely reaching a manager's phone still depends on B-20: the SMS adapter logs
rather than sends. WhatsApp to staff works today for any staff member with a
phone number on their account.

---

## Open — carried from Phase 4 (real-time and KDS)

### B-17. KDS disconnect detection (§70)

**Phase:** 4 · **Status:** not started

§70 lists "KDS disconnected" as a critical alert. The stream heartbeats and the
client can detect staleness, but the API keeps no registry of connected screens,
so nothing server-side notices when a kitchen's display drops off. Needs a
presence record keyed by branch, updated on connect and heartbeat.

### B-18. Outbox retention

**Phase:** 4 · **Status:** minor, but unbounded

Processed outbox rows are never deleted. They are a useful event log, but the
table grows forever. Needs a retention policy and a prune job — the same sweeper
that B-13 needs for carts and idempotency keys.

---

## A note on the UI backlog

Closed. `apps/dashboard` now ships sign-in, live orders, the menu manager and
the kitchen display, verified by 20 browser tests against the real stack — see
[DASHBOARD.md](./DASHBOARD.md). What remains of the original UI backlog is
image upload (B-2) plus the smaller editors listed in B-19.

---

## Open — carried from Phase 3 (orders)

### B-11. Delivery zone management API

**Phase:** 3 · **Status:** not started · **Blocks:** any restaurant configuring
its own delivery area

Delivery zones drive branch selection and the delivery fee, and the resolution
rules are implemented and tested. There is no CRUD endpoint: zones can only be
created by the seed script or by direct SQL, so a restaurant cannot define where
it delivers without an engineer.

Deferred as administrative configuration, the same call as the menu-management
UI (B-1) — and it lands most naturally on the same screens.

**Needs:** CRUD under `/branches/:id/delivery-zones` behind `branches.manage`,
plus the dashboard screen. Polygon zones can follow; the domain function that
matches a point to a zone is already the only place shape logic lives, so adding
one does not touch callers.

### B-12. Discounts are plumbed but never computed

**Phase:** 3 · **Status:** deliberate

`computeOrderTotals` takes a discount, applies it before tax and caps it at the
subtotal, and `orders.discount_amount` stores the result. Nothing produces a
non-zero value: promotions and coupons are Phase 12. The path is tested with
explicit discounts so that when promotions arrive they have somewhere correct to
plug into.

### B-13. No sweeper for expired carts or idempotency keys

**Phase:** 3 · **Status:** waiting on Phase 4

`carts.expires_at` and `idempotency_keys.expires_at` are both set and both
indexed; nothing prunes either. Phase 5 added a third candidate: finished
`notifications` rows. Expired idempotency keys are handled correctly
on read — an expired key is treated as absent — so this is housekeeping rather
than a correctness problem. Needs the Phase 4 worker.

### B-14. Blocked customers can still build a cart

**Phase:** 3 · **Status:** minor

`customers.is_blocked` is enforced at checkout and when attaching a customer to
a cart, but a cart created without a customer and only associated at checkout
lets a blocked customer get all the way to the last step before being refused.
Harmless, but poor service.

---

## Open — carried from Phase 1

### B-3. Password reset and invitation email

**Phase:** 1 · **Status:** not started

`StaffService.invite` creates a user with an unusable random password. There is
no email delivery and no reset flow, so an invited person cannot sign in without
an administrator setting a password directly in the database.

**Needs:** the email channel from B-20 — the abstraction itself landed in Phase
5 — then a `password_reset_tokens` table and the two endpoints.

### B-4. Two-factor authentication enforcement

**Phase:** 1 · **Status:** columns exist, unused

`users.two_factor_secret` and `two_factor_enabled_at` exist. Nothing issues,
verifies or enforces a second factor. ENGINEERING_SPEC.md §5 and §66 ask for it
on privileged accounts.

### B-5. Platform back office

**Phase:** 1 · **Status:** not started

`PLATFORM_ADMIN` and `users.is_platform_admin` exist and `@PlatformOnly()`
guards it, but no endpoints use it. Onboarding, suspending or inspecting a
tenant currently requires database access.

### B-6. Permission caching

**Phase:** 1 · **Status:** deliberate, revisit with data

Roles and permissions are re-read from the database on every authenticated
request — two queries per call. That is what makes revocation immediate, which
was the right default. Revisit only when Phase 9's analytics gives real latency
numbers; caching authorization on a guess is how stale-permission bugs start.

---

## Open — cross-cutting, not yet scheduled

### B-7. Menu import (spec §73)

PDF, Excel, CSV, image or existing website → AI-extracted draft → admin review
before publishing. Described in §73 but present in no sprint. It is the single
biggest onboarding accelerator for home kitchens, which are the tenants least
likely to type a menu in by hand.

**Recommend:** schedule explicitly, most naturally alongside Phase 11's AI layer.

### B-8. SaaS billing

There is no `plans`, `subscriptions` or `tenant_invoices` model. Nothing charges
the restaurant. Needed before commercial launch even in a trivial form.

### B-9. Receipt and kitchen printing

Thermal ESC/POS printing is expected by most local restaurants and is absent
from the spec entirely. Confirm whether pilot customers need it; if so it lands
with the POS in Phase 7.

### B-10. Per-branch category ordering

Category `sort_order` is tenant-wide. Chains that merchandise differently by
city will want it per branch. Low priority until a chain asks.

---

## Closed

### B-1. Menu management UI — done

Shipped as `/menu` in `apps/dashboard`: categories and items listed with
branch-resolved prices, an item editor, sold-out toggling per branch, and the
per-branch price override. Verified by browser tests, including one that marks
an item sold out at one branch and proves another is unaffected.

See [DASHBOARD.md](./DASHBOARD.md).

### B-15. The kitchen screen — done

Shipped as `/kds`: the four columns from §34, live SSE updates, per-stage timers
with urgency banding, the unacknowledged banner, sequence-gap detection with
snapshot recovery, a staleness indicator, and the explicit sound unlock that
plan §2.8 called for.

Verified by browser tests, including the one that matters most: an order placed
through the API appears on an already-open kitchen screen with no reload.
