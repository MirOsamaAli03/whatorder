# Phase 2 — Menu

Covers Sprint 2 of ENGINEERING_SPEC.md §83 and §86, plus the two schema gaps the
plan identified in §2.4. Complete and verified. The menu management UI that this
phase deferred has since shipped — see [DASHBOARD.md](./DASHBOARD.md).

## What exists

### Data

Eight new tables, all tenant-owned and all under RLS:

| Table | Notes |
|---|---|
| `menu_categories` | Sort order, archive flag, localized names |
| `menu_items` | Base price, cost price, prep time, availability, archive flag |
| `menu_item_variants` | Size or portion; the price **replaces** the base price |
| `modifiers` | A group of choices — "Choose your sauce" |
| `modifier_options` | The individual choices, with a price delta |
| `menu_item_modifiers` | **Missing from spec v1** — nothing joined a modifier group to an item, so the modifier system could not function at all |
| `branch_menu_overrides` | **Missing from spec v1** — per-branch price and availability, which §86 asks for but the v1 schema cannot express |
| `outbox_events` | §58's transactional outbox, landing early so availability changes have somewhere durable to go |

### Domain logic

`packages/domain/src/menu.ts` — pure functions, no framework, no Prisma:

- `resolvePrice` / `resolveAvailability` — combine the tenant-wide value with a branch override
- `isOrderable` / `isVisibleToCustomer` — the two different questions a menu answers
- `validateModifierSelection` — required, min, max, unknown and unavailable options
- `resolveUnitPrice` — base or variant price, plus modifier deltas, clamped at zero

Every channel reads a menu through these, so the POS, WhatsApp, QR ordering and
the AI tool layer cannot disagree about what something costs (§87).

### API

```text
GET    /api/v1/menu                                  ?branchId= &includeHidden=
GET    /api/v1/menu/items/:id                        ?branchId=
GET    /api/v1/menu/modifiers

POST   /api/v1/menu/categories                       menu.create
PATCH  /api/v1/menu/categories/:id                   menu.update
DELETE /api/v1/menu/categories/:id                   menu.delete   (archives)

POST   /api/v1/menu/items                            menu.create
PATCH  /api/v1/menu/items/:id                        menu.update
DELETE /api/v1/menu/items/:id                        menu.delete   (archives)
POST   /api/v1/menu/items/:id/availability           menu.update
PUT    /api/v1/menu/items/:id/branches/:branchId     menu.update
DELETE /api/v1/menu/items/:id/branches/:branchId     menu.update
PUT    /api/v1/menu/items/:id/modifiers              menu.update

POST   /api/v1/menu/items/:id/variants               menu.create
PATCH  /api/v1/menu/variants/:id                     menu.update
DELETE /api/v1/menu/variants/:id                     menu.delete

POST   /api/v1/menu/modifiers                        menu.create
PATCH  /api/v1/menu/modifiers/:id                    menu.update
DELETE /api/v1/menu/modifiers/:id                    menu.delete   (archives)
POST   /api/v1/menu/modifiers/:id/options            menu.create
PATCH  /api/v1/menu/options/:id                      menu.update
DELETE /api/v1/menu/options/:id                      menu.delete
```

Marking a dish sold out needs only `menu.update`, which a branch manager holds.
Changing a price or adding a dish needs `menu.create` / `menu.delete`, which
they do not. That split is deliberate: sold-out is a floor decision made twenty
times a week, and a price change is not.

## Decisions worth recording

**A branch override may restrict availability, never loosen it.** The effective
state is the *more restrictive* of the tenant-wide value and the branch
override, so an item withdrawn chain-wide — discontinued, recalled, out of
season — cannot become orderable again because one branch has a stale row.
Restricting is always safe; loosening is not. The cost is that a branch cannot
pilot an item hidden chain-wide, which is instead done by leaving the item
available and hiding it at every branch except the pilot.

**Three availability states, not one boolean.** Spec §9 gives `menu_items` a
single `is_available` flag, but §10 requires AVAILABLE, OUT_OF_STOCK and HIDDEN,
and they behave differently for a customer: sold out stays on the menu, visibly
unavailable, while hidden does not appear. `is_active` is separate again — it
archives an item for administrators without saying anything to customers.

**Items and categories archive; they never hard delete.** Order lines will
reference `menu_item_id` from Phase 3, and even with price snapshotting (§13) a
dangling reference is worse than a flag. Archiving a category leaves its items
in place as uncategorized rather than taking them down with it.

**A variant replaces the price rather than adding a surcharge.** "Large" is
priced outright at 1500, not as base + 600. Surcharge pricing makes every price
change a two-place edit, and the two places drift.

**Money leaves the API as a fixed two-place string.** `Prisma.Decimal.toString()`
drops trailing zeros, so a column holding 450.00 stringifies as `"450"` — which
produced a response with `basePrice: "450"` next to `price: "450.00"`. Every
monetary field now goes through `toMoneyString`, so clients never have to
normalise money themselves and never reach for `parseFloat`.

**Modifier group configuration is validated against the merged result.** A patch
that changes only `selectionType` to SINGLE while the stored `maxSelections` is
still 4 would leave a group where every possible selection fails at order time.
The check runs on the merged values, not on the patch.

**Availability changes write an outbox event in the same transaction.** §10
requires availability to reach POS, WhatsApp, website and QR ordering
immediately. The event is written atomically with the change, so the pair cannot
diverge; Phase 4's worker publishes them. Until then the table is a durable,
ordered record.

## Verification

**145 tests, all passing** (was 88 at the end of Phase 1).

| Suite | Count | Needs a database |
|---|---|---|
| `packages/domain` — Money, authorization, **menu** | 61 | no |
| `packages/database` — enum parity, RLS coverage | 15 | no |
| `apps/api` — tenant isolation, auth, rate limiting, **menu** | 69 | yes |

```bash
npm run build && npm run typecheck && npm run lint && npm test
```

The RLS coverage guard now reads **every** migration rather than only the Phase 1
file — it was pinned to one path, which would have silently stopped covering
each new phase's tables. It confirms all eight new tables have policies.

### Live verification

Twenty checks against a running server and the seeded demo data, covering the
cases that only appear with real data: the BBQ Platter priced at 2400 in Karachi
and 2650 in Lahore, sold out at Gulshan while available elsewhere, Urdu names
surviving the round trip, every price matching `^\d+\.\d{2}$`, and a home-kitchen
tenant getting a 404 for a chain item's real id.

## Known gaps

- ~~**No dashboard UI.**~~ Shipped — see [DASHBOARD.md](./DASHBOARD.md).
- **No image upload.** `imageUrl` accepts a URL, but there is no S3 presigned
  upload flow yet — it is better built alongside the UI that will use it.
- **No menu import** (§73: PDF/Excel/CSV/image → AI draft → admin review). Worth
  scheduling explicitly; it is the single biggest onboarding accelerator for home
  kitchens.
- **Availability events are written but not published.** The outbox worker
  arrives in Phase 4, so a POS will not yet learn about a sold-out dish without
  refetching.
- **Category ordering is global, not per branch.** Fine for now; chains that
  merchandise differently by city will eventually want it.
