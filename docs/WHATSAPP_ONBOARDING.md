# Connecting a restaurant's WhatsApp number

The onboarding path for a new tenant, and the objection you will hit on the way.

Read this before promising a pilot restaurant a date. The technical work is
about twenty minutes; the parts that take days are Meta's, and one of them asks
the restaurant to give something up.

---

## The objection, first

**A phone number cannot be in the WhatsApp Business *app* and the WhatsApp
Business *API* at the same time.**

Every restaurant you want as a customer is already using their number in the
app: the owner has it on their phone, staff reply from it, and there is a chat
history going back years. Moving that number onto the API means:

- the app stops working on that number, on every phone;
- the chat history in the app does **not** come with it — it stays on the device
  and is not readable through the API;
- labels, quick replies, catalogue and away messages set up in the app are gone;
- replying to customers now happens in this dashboard, not in the app they know.

This is the single biggest onboarding objection, and it is not a technical
problem that can be engineered away — it is Meta's design. Raise it in the first
conversation rather than the last. A restaurant that discovers it on migration
day will stop the migration.

### The two honest options

**Option A — migrate the existing number.** They keep the number their customers
already have, printed on their signage and saved in a thousand phones. They lose
the app. Right for a restaurant whose WhatsApp ordering is already a real
channel, because the number *is* the asset.

**Option B — a new number for ordering.** The app keeps working on the old
number for whatever staff use it for; the new number goes on the menu, the
receipts and the social profiles. Nothing is lost, but the ordering number has
to be publicised from scratch, and customers messaging the old one get no bot.

Option B is usually the better pilot: it removes the objection entirely, it is
reversible, and a week of live orders does not need the famous number. Migrate
in Option A only once the restaurant has decided the system is worth keeping.

### Before migrating an existing number

1. **Export the chat history from the app** — Settings → Chats → Chat history →
   Export chat, per conversation. It is not transferable, only savable. Do this
   first; it cannot be done afterwards.
2. **Write down anything configured in the app**: away message, greeting, quick
   replies, labels, the catalogue.
3. **Warn the staff who use that number.** The app will sign out and not come
   back.
4. Pick a quiet day. There is a window during verification when the number
   receives nothing.

---

## What Meta requires

Roughly in this order. Items 1–3 are theirs and can take days.

1. **A Meta Business account**, verified. Business verification wants
   registration documents and can take several days, sometimes more than a week.
2. **A WhatsApp Business Account (WABA)** inside it.
3. **A phone number**, verified by SMS or call, and not currently active in the
   WhatsApp Business app (see above).
4. **A display name** that matches the business and passes Meta's review.
5. **Message templates**, approved per language, for anything sent outside the
   24-hour window. See below.

Going through a BSP (360dialog, Twilio, Interakt) instead of Meta directly
usually shortens 1–3 considerably and is what this platform is built for —
`whatsapp_accounts.provider` chooses the adapter per tenant, so the decision is
a row in the database and not a code change.

---

## The 24-hour window, and why templates matter

A business may send free-form messages only within **24 hours** of the
customer's most recent message. Outside that window, only a **pre-approved
template** may be sent.

For a restaurant this means:

- A customer who orders and stays quiet for a day **cannot** be sent a free-form
  "your order is out for delivery". It has to be a template.
- Every order-status notification therefore needs an approved template, or it is
  suppressed — with a reason, which is visible on the Settings screen.
- A member of staff replying from the Conversations screen is sending a
  free-form message. The dashboard greys the reply box out and says so when the
  window has closed, rather than letting them type a paragraph and have it
  refused.

Template approval is asynchronous, takes hours to a day, and can be **rejected**
— commonly for promotional wording in a template registered as UTILITY. A
rejected template is the most likely reason a restaurant's customers quietly
stop hearing from them, which is why the Settings screen calls it out at the top
of the page with Meta's own reason next to it.

**Register templates during onboarding, not after go-live.** They are the long
pole.

---

## Connecting the number in Restaurant OS

Once Meta's side is done, in **Settings → WhatsApp numbers → Connect a number**:

| Field | Where it comes from |
|---|---|
| Phone number ID | The provider's id for the number. Not the number itself. |
| Number | The number in any readable form; it is normalised to E.164. |
| WhatsApp Business Account ID | Optional, useful for support. |
| Branch | The outlet this number serves. Leave as *All branches* only for a single-branch tenant — see the limitation below. |
| Access token | The provider credential. Stored write-only and never shown again. |

Then point the provider's webhook at:

```text
https://<your-api-host>/api/v1/webhooks/whatsapp
```

with the verify token from `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and the app secret in
`WHATSAPP_WEBHOOK_SECRET`. Both are validated: the subscription handshake fails
without the first, and every delivery is HMAC-checked against the second.

> **Set `WHATSAPP_WEBHOOK_SECRET` before connecting a real number.** Without it
> the signature check is skipped — fine for development, and logged as a warning
> on every request — but in a deployment it means anyone who finds the URL can
> forge a message from a customer.

### Checking it works

Message the number "menu". You should get a tappable list back within a second
or two. If nothing happens:

- **No reply at all, and nothing in the logs** — the webhook is not reaching the
  API, or the signature is wrong. A failed signature is a 403.
- **A log line about an unknown `phone_number_id`** — the number is connected to
  a different tenant, or the id was mistyped. The payload is recorded rather
  than dropped; look in `inbound_webhook_events` with a null tenant.
- **A reply, but no menu items** — the branch has no visible, in-stock items.

---

## Known limitations at pilot

- **A multi-branch tenant on one number** picks the oldest active branch for
  every conversation. Give each outlet its own number, or wait for B-25.
- **Modifiers and variants** cannot be chosen in the conversation (B-26). Fine
  for a menu of single-price dishes; a menu sold by size is not usable over
  WhatsApp yet.
- **Free text outside the keyword list** is not understood (B-27) — the bot
  offers its buttons again. English and Roman Urdu keywords are covered, and a
  typed dish name searches the menu.
- **Escalation alerts do not reach a phone** (B-20): SMS has no provider
  configured, so the last rung of the unacknowledged-order ladder is logged
  rather than sent. Keep the dashboard open during service.

---

## The pilot checklist

- [ ] Migration decision made and, for Option A, chat history exported
- [ ] Meta business verification complete
- [ ] Number verified and connected in Settings
- [ ] Webhook secret and verify token set in the deployment
- [ ] Webhook subscribed and the handshake accepted
- [ ] Templates registered for every order status, in the languages used
- [ ] All templates showing APPROVED on the Settings screen
- [ ] Menu loaded, with prices and availability correct for the branch
- [ ] Test order placed end to end, and seen on the kitchen screen
- [ ] Staff shown the Conversations screen and the handoff flow
- [ ] Acknowledgement timeout and escalation ladder agreed with the manager
