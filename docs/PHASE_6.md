# Phase 6 — WhatsApp inbound ordering

Covers ENGINEERING_SPEC.md §21 (WhatsApp architecture), §22 (conversation
state), §23 (intents), §27 and §28 (cart and checkout) and plan §2.2's
deterministic-first recommendation. Complete and verified.

This is the phase where the product becomes demonstrable: a customer messages a
restaurant's WhatsApp number and an order appears on the kitchen screen, with no
app, no website and nobody at the restaurant typing anything.

## What exists

```text
customer                 Meta            this API
   │  "menu dikhao"        │                │
   ├──────────────────────>│  webhook       │
   │                       ├───────────────>│ verify signature
   │                       │                │ deduplicate (spec 68)
   │                       │                │ route phone_number_id -> tenant
   │                       │                │ record inbound message
   │                       │                │      │
   │                       │                │      ▼  ConversationService
   │                       │                │   resolve intent (domain)
   │                       │                │   MenuService / CartService /
   │                       │                │   OrdersService  ← the same ones
   │                       │                │   the POS and dashboard call
   │  tappable menu        │                │      │
   │<──────────────────────┤<───────────────┤ send replies
```

### The conversation

`packages/domain/src/conversation.ts` — pure, 31 tests, no database:

- the ten-state machine from §22, as a transition matrix;
- `resolveIntent`, which turns a tap or a line of text into one of §23's
  intents;
- reply-id encoding, the contract that makes a tap readable;
- WhatsApp's list and button limits, and paging around them;
- everything the bot says.

### The engine

`apps/api/src/whatsapp/` — `ConversationService` (the flow), `BotIdentityService`
(who it acts as), `WhatsAppSenderService` (immediate replies).

The flow: greet → browse or search → tap a dish → quantity → cart → order type →
address if delivering → confirm → order placed → track. Plus a human handoff at
any point, and a cancel at any point.

### Data

Migration `20260901000900`: `conversation_sessions`, with RLS. 38 tables under
Row-Level Security, 57 policies, the same four deliberate exceptions.

## Decisions worth recording

**The bot is a real principal, not a synthetic context.** The channel has to
call CartService and OrdersService — §21 requires it and §87 forbids a
`WhatsAppOrderService` shadowing them — and those services want to know who is
asking. The easy answer is a hand-built `AuthContext` that grants itself
whatever it needs, which would have quietly placed the one component taking
instructions from the public internet outside the authorization model.

Instead the bot has a real user, a real membership and a real role
(`SystemRole.CHANNEL_BOT`), confined to one branch through
`membership_branches`. So `canAccessBranch` applies to it, RLS applies to it, the
audit log names it — a live order audits to `WhatsApp
<whatsapp-bot+…@channels.restaurant-os.local>` — and a restaurant can see in
their staff list exactly what it may do. Its grants are the narrowest in the
system: menu.view, orders.create, orders.view, customers.view/update,
branches.view. Deliberately **no** `orders.update`: a message from a customer
must never advance an order through the kitchen, or the KDS becomes a
suggestion. No cancel, no payments, no analytics, no audit.

This is also what will make invariant 9 structural when Phase 11 adds a model:
the model produces intents, but they execute as *this* principal, so no prompt
can talk its way into a permission it does not hold.

**Deterministic first, AI later — and the ordering of that is the point.** Plan
§2.2 against the spec's §23–§25. A customer taps a list row whose id already
names the menu item, so the common path needs no language understanding at all:
it is faster, cheaper, and it keeps working when an LLM is down. Phase 11 adds a
model as a *fallback* for the text this engine returns UNKNOWN for, producing
the same intents, validated by the same services.

**The state is what makes a message readable.** "1" is a menu selection while
browsing, a quantity while building a cart, and an order type while choosing
one. More sharply: at the address prompt, *anything* typed is the address — a
stateless matcher reads "House 5, Street 2, Phase 4" as a menu search for
"phase" and asks the customer to repeat themselves, which is where
conversational ordering usually dies.

**Roman Urdu is a first-class input, which the spec never mentions.** Plan §2.3.
In this market customers write "menu dikhao" and "mera order kahan hai" far more
often than clean English, and a bot that only understands English reads as a bot
that does not work. The keyword list covers both, and its *order* matters: "mera
order kahan hai" contains both "order" and "kahan", and a test caught it being
read as a menu request because the broader entry came first.

**A tap always beats the text.** WhatsApp sends the row's title as the text of
an interactive reply, so a row labelled "Cancel my order" would otherwise be
read twice — once correctly from its id, and once by keyword.

**The bot goes silent after a handoff.** Once a person is involved, a bot
replying over the top of them is worse than a bot saying nothing, and a customer
who asked for help does not want to be answered by the thing they gave up on.
`HUMAN_HANDOFF` is a dead end in the transition matrix with exactly one exit, to
IDLE, which only a person can take. The customer's messages are still recorded,
so the person sees what was said.

**Replies are returned, not sent.** `ConversationService.handle` produces
messages and the caller sends them. The whole engine is therefore testable
without a provider, and a send failure is handled in one place instead of at
every branch of the conversation.

**Conversational replies do not go through the notification pipeline.** A
notification is something the restaurant owes the customer and may usefully
arrive after an hour of retries; a reply is half of a conversation happening
now, and one that arrives ten minutes later is worse than none. So replies go
straight to the provider. The consequence — a provider outage costs replies — is
correct, because invariant 8 protects the *order* and at that point there is no
order; it is why a failed reply is logged loudly rather than swallowed.

**The conversation runs after the webhook's transaction commits, not inside it.**
The engine opens its own tenant-scoped transaction per service call, and nesting
those inside the webhook's would hold a connection for the whole exchange and
deadlock the moment the pool ran dry. It also means the inbound message is
durably recorded before any reply is attempted: a crash mid-conversation loses
the reply, never the record that the customer wrote.

**Interactive limits are enforced when a message is built.** Three buttons, ten
rows across *all* sections, twenty characters on a button title. Exceeding any
of them makes WhatsApp reject the entire message, so the customer sees nothing
rather than something truncated — and a dish named "Chicken Malai Boti Handi
(Family Size)" is enough to trigger it. The builders truncate and drop rather
than letting a long menu discover this in production.

**Only the order types the branch offers are shown.** Offering dine-in at a
delivery-only home kitchen wastes a tap and then has to be refused.

**An address under eight characters is refused.** Better to ask again than to
send a rider to "dha".

## Verification

**439 tests, all passing** (375 at the end of Phase 5).

| Suite | Count | Needs a database |
|---|---|---|
| `packages/domain` — money, authz, menu, state machine, pricing, kitchen, notifications, **conversation** | 188 | no |
| `packages/database` — enum parity, RLS coverage | 34 | no |
| `packages/whatsapp` — provider, registry, **interactive message limits** | 15 | no |
| `packages/notifications` — channel adapters | 7 | no |
| `apps/api` — isolation, auth, menu, orders, kds, notifications, pipeline, **whatsapp ordering** | 195 | yes |

```bash
npm run build && npm run typecheck && npm run lint && npm test
```

All ten migrations apply to an empty database.

### The plan's exit criterion

> *"the §71 e2e — WhatsApp order → kitchen → delivery → completion — passes
> against a mocked BSP"*

`apps/api/test/whatsapp-ordering.test.ts` drives the whole thing through the
webhook, exactly as Meta would: every customer message is an HTTP POST carrying
a provider payload, and every reply is read back from the provider the
application actually sent it to. Nothing between the two is stubbed.

Greeting → menu list → tap a dish → quantity → second dish by *typed* quantity →
checkout → delivery → address (one refused as too short) → confirmation with the
server's delivery fee → order placed → the card appears on the KDS carrying no
phone number → tracking in Roman Urdu → ACCEPTED → PREPARING → READY →
OUT_FOR_DELIVERY → DELIVERED.

One correction to the criterion's wording: **DELIVERED is terminal for a
delivery order** — that *is* its completion. `COMPLETED` is where pickup and
dine-in end. The test asserts the state machine refuses to move an already
delivered order, which is the behaviour §15's matrix defines.

### Live verification

A complete order against a running API with signature verification on, driven by
signed webhooks: greeting, menu, dish, quantity, checkout, pickup, confirm —
producing order `MAIN-0001` at PKR 402.50, tax computed by the pricing engine
from tenant settings, audited to the bot principal by name. Then tracking, a
handoff, and a message after the handoff that correctly produced **no reply at
all**.

## Known gaps

Tracked in [BACKLOG.md](./BACKLOG.md). New in this phase: no staff inbox for
handed-off conversations (B-24), a multi-branch tenant on a single number picks
the first branch rather than asking (B-25), and modifiers and variants cannot be
chosen in the conversation (B-26).
