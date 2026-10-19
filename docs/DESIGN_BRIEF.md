# Redesign brief — Restaurant OS dashboard

Everything below the line is written to be pasted into a design tool as a single
prompt. The audit it is based on was made by screenshotting all six screens at
1440px, 900px and 390px against the running application with real seeded data,
and by measuring the current palette's contrast ratios.

Screenshots are in `ui-audit/` (not committed). Attach at least
`phone-menu.png`, `desktop-menu.png`, `desktop-kds.png` and
`desktop-settings.png` — they show the four worst problems.

---

## PROMPT

You are redesigning the staff dashboard of **Restaurant OS**, a WhatsApp
ordering and point-of-sale system used by restaurants, home kitchens and small
chains in Pakistan. Customers order through WhatsApp; this dashboard is what the
restaurant's own staff use to run the business.

I need a complete visual redesign: a design system plus a redesign of six
screens. The current interface works but looks like an internal developer tool,
not a product a restaurant owner would be pleased to put on their counter.

### Who uses it, and where

Design for these three people specifically. They are not office workers at
desks.

| Person | Device | Conditions |
|---|---|---|
| **Kitchen staff** | A tablet bolted to a wall, or a cheap Android screen | Reads it from 1.5–2 metres away, hands wet or gloved, bright kitchen lights, noisy, under time pressure |
| **Counter staff / cashier** | A laptop or an old desktop, often 1366×768 | Glancing between the screen and a customer standing in front of them |
| **Owner** | **A phone**, constantly | On the move, between branches, at home in the evening, one-handed |

The owner being on a phone matters most: today the dashboard is **completely
unusable on a phone**, which is the single biggest failure in the current
design.

### What the six screens are

1. **Login** — email and password. There is also a second state where an account
   belongs to more than one restaurant and must pick one.
2. **Live orders** — a table of today's orders at one branch, with status and
   actions to move an order forward.
3. **Kitchen display** — four columns (New, Accepted, Preparing, Ready) of order
   cards, each with a running timer, the items, and buttons to advance it. Cards
   turn amber then red as they age, and an unacknowledged order pulses. This is
   the wall-mounted screen.
4. **Conversations** — a two-pane inbox of customers who asked to speak to a
   human. Left: who is waiting, longest first, with the waiting time as the
   loudest element. Right: the message thread and a reply box.
5. **Menu** — categories, each containing dishes with price, availability, and
   buttons for "sold out", a branch-specific price, and edit.
6. **Settings** — connecting a WhatsApp number, message templates, and a grid of
   which notification channels are on for which recipients.

### The specific problems to fix

These were measured, not guessed.

**1. The app does not work on a phone at all.**
The layout is `grid-template-columns: 220px 1fr` with no breakpoint for the app
shell. On a 390px phone the sidebar still takes 220px, leaving about 170px for
the entire application. Content is crushed into an unreadable strip. There are
only three media queries in 881 lines of CSS, and none of them touch the shell.
The navigation needs to become a bottom bar or a drawer on small screens.

**2. Action buttons wrap and break row alignment.**
On the menu screen each row ends with three buttons in a 180px column. They wrap
to two lines — "Sold out" and "Branch price" on one, "Edit" dropped below —
so no two rows line up and the list looks broken. Rows need either an overflow
menu, icon buttons, or a wider, properly reserved action area.

**3. Labels collide with their controls.**
The "Branch" label sits so close to its dropdown that it is visually clipped on
three screens. On Conversations, "Show all conversations" wraps to two lines
with its checkbox floating at the top-left instead of centred against it. Page
headers need a real layout, not a flex row with gaps.

**4. The colour fails accessibility, including on the primary button.**
Measured against WCAG AA (needs 4.5:1 for normal text):

| Pair | Ratio | Verdict |
|---|---|---|
| White on the blue accent `#3d8bfd` | **3.33** | Fails — and this is the primary button and the selected nav item |
| Faint text `#6b7885` on surface `#171c22` | **3.79** | Fails — used for counts, captions, table headers, empty states |
| Danger red `#e5484d` on surface | **4.38** | Fails, just |

Every colour you choose must pass 4.5:1 for text and 3:1 for interface
boundaries, and you must state the ratios.

**5. The theme is wrong for the product.**
It is a near-black slate-grey developer theme (`#0f1216`, `#171c22`) with one
generic blue. Nothing about it says food, warmth, or hospitality. It is also
dark-only — `color-scheme: dark` is hard-coded with no light theme, which is a
poor default for a counter in a brightly lit shop.

**6. The kitchen display is not built like a kitchen display.**
It still carries the 220px app sidebar, wasting a fifth of a wall-mounted
screen. Column headings are 13px, far too small to read across a room. The four
columns are identical grey, so the stage of an order carries no colour meaning.
Empty columns say "Empty" in small faint grey.

**7. Raw database values are shown to users.**
Settings lists channels as `whatsapp`, `sms`, `email`, `push`, `dashboard` and
recipients as `customer` — lowercase, straight from the database. The menu shows
modifier group names like "Spice level · Add-ons" as a dish subtitle with no
explanation. Native unstyled browser checkboxes sit in a dark theme.

**8. Empty and idle states are dead space.**
"No live orders at this branch." is a thin dashed box with roughly 700px of
blank screen below it. Empty states should be designed, not left over.

**9. No food, anywhere.**
A menu screen for a restaurant with no dish images, no category imagery, no
colour coding. Prices are set in a monospace font, which makes money look like
log output.

**10. Urdu is unstyled.**
Dish names carry Urdu alongside English (`چکن تکہ`). It renders at the same tiny
caption size as everything else with no font or line-height consideration and no
RTL handling. Urdu needs a proper size, font stack and line height.

### What I want

**A warm, confident, food-appropriate visual identity.** Vibrant, but used with
discipline — strong colour where it carries meaning (order urgency, status,
primary action) and calm neutrals everywhere else. It should feel like a
hospitality product, not a SaaS admin panel or a crypto dashboard. Avoid both
the current cold slate-grey and a generic purple-gradient startup look.

Consider that this is for the Pakistani market: the people using it serve
biryani and karahi, and the interface should not look imported from Silicon
Valley.

**Both a light and a dark theme.** Light as the default for counter and office
use; dark available and genuinely designed, not an inversion. The kitchen
display should work in both.

**Deliver:**

1. **A design system** — colour tokens with the contrast ratio of every text
   pair stated; a type scale; spacing scale; corner radii; elevation; and the
   states (default, hover, focus, active, disabled, loading) for buttons,
   inputs, selects, checkboxes, pills and cards. Focus states must be visible
   for keyboard users.
2. **Each of the six screens**, at desktop (1440), tablet (900) and phone (390).
   The phone layouts matter as much as the desktop ones.
3. **The kitchen display treated as its own thing** — full-bleed, no app
   navigation, type large enough to read at two metres, colour carrying the
   urgency, and a clear visual difference between the four columns.
4. **Designed empty states** for every screen.
5. **A loading and an error state** for a data-backed screen.
6. **The order-status colour language**, consistent everywhere it appears:
   new, accepted, preparing, ready, delivered, cancelled, plus the three urgency
   levels on the kitchen cards (normal, warning, critical).

### Technical constraints — please respect these

- The app is **Next.js 15 with React 19**. Styling is **one plain CSS file**
  (`globals.css`, 881 lines) using CSS custom properties. There is no Tailwind
  and no component library, and this was a deliberate decision for six screens.
  Prefer a design that stays plain CSS with custom properties. If you believe a
  dependency is genuinely necessary, say so explicitly and justify it rather
  than assuming it.
- Give me **CSS custom property tokens I can drop into `:root`**, with the light
  and dark values side by side.
- Keep the existing class names where you reasonably can (`.shell`, `.sidebar`,
  `.card`, `.btn`, `.pill`, `.kds-card`, `.inbox-row`, …) so the redesign can be
  applied without rewriting every component. Where a new structure is genuinely
  needed, show the markup.
- Respect `prefers-reduced-motion`: the kitchen display currently pulses an
  unacknowledged order and falls back to a static outline. Keep that behaviour.
- Must work on a 1366×768 laptop, which is common in this market.
- No icon-only buttons without accessible labels.

### What not to change

- The information on each screen is right. The problem is presentation, not
  what is being shown.
- The kitchen display's core idea — four columns, a timer per order, colour
  escalating with age — is correct and should be made stronger, not replaced.
- The waiting time being the loudest element in the conversations list is
  deliberate. Keep it.

Start by proposing the colour system and type scale with contrast ratios, and
let me approve those before you design the screens.
